import { setFailed } from "@actions/core";
import {
  postComment,
  requireEvent,
  assertValidFilename,
  requirePullNumber,
  requirePr,
  requireFiles,
  getFileDiff,
  assertFilenameAndFileNumbersMatch,
  assertConstantEipNumber,
  assertConstantStatus,
  assertHasAuthors,
  assertIsApprovedByAuthors,
  requireAuthors,
  requestReviewers,
  assertValidStatus,
  requireFilePreexisting,
  assertEIPEditorApproval,
  assertEIP1EditorApprovals,
  requireEIPEditors
} from "./lib";
import {
  DEFAULT_ERRORS,
  File,
  MENTIONS_SEPARATOR,
  NodeEnvs,
  TestResults
} from "./utils";
import {
  editorApprovalPurifier,
  EIP1Purifier,
  getAllTruthyObjectPaths,
  innerJoinAncestors,
  statusChangeAllowedPurifier
} from "./lib/Purifiers";
import { get } from "lodash";

const testFile = async (file: File): Promise<TestResults> => {
  // we need to define this here because the below logic can get very complicated otherwise
  const errors = DEFAULT_ERRORS;

  // file testing is not compatible (yet) with an initialy undefined file
  // so instead it's required here. It throws an exception for consistency
  const fileDiff = await getFileDiff(file);
  try {
    file = await requireFilePreexisting(file);
  } catch (err) {
    errors.fileErrors.filePreexistingError = err;
    errors.approvalErrors.isEditorApprovedError = await assertEIPEditorApproval(
      fileDiff
    );
    // new files are acceptable if an editor has approved
    if (errors.approvalErrors.isEditorApprovedError) {
      return {
        errors,
        fileDiff
      };
    }
  }

  errors.approvalErrors.isEditorApprovedError = await assertEIPEditorApproval(
    fileDiff
  );
  errors.approvalErrors.enoughEditorApprovalsForEIP1Error = await assertEIP1EditorApprovals(
    fileDiff
  );
  errors.fileErrors.validFilenameError = assertValidFilename(file);
  errors.headerErrors.matchingEIPNumError = assertFilenameAndFileNumbersMatch(
    fileDiff
  );
  errors.headerErrors.constantEIPNumError = assertConstantEipNumber(fileDiff);
  errors.headerErrors.constantStatusError = assertConstantStatus(fileDiff);
  errors.headerErrors.validStatusError = assertValidStatus(fileDiff);
  errors.authorErrors.hasAuthorsError = assertHasAuthors(fileDiff);

  // if no authors then remaining items aren't relevant to check
  if (errors.authorErrors.hasAuthorsError) {
    return {
      errors,
      fileDiff
    };
  }

  errors.approvalErrors.isAuthorApprovedError = await assertIsApprovedByAuthors(
    fileDiff
  );
  return {
    errors,
    fileDiff,
    authors: requireAuthors(fileDiff)
  };
};

const getEditorMentions = (testResults: TestResults) => {
  const {
    errors: { fileErrors, approvalErrors, headerErrors },
    fileDiff
  } = testResults;

  const editors = requireEIPEditors(fileDiff);

  // new eips require editor approval
  if (fileErrors.filePreexistingError && approvalErrors.isEditorApprovedError) {
    return editors.join(MENTIONS_SEPARATOR);
  }

  // eip1 requires more than 1 editor approval
  if (approvalErrors.enoughEditorApprovalsForEIP1Error) {
    return editors.join(MENTIONS_SEPARATOR);
  }

  // valid status errors require editor approval
  if (headerErrors.validStatusError && approvalErrors.isEditorApprovedError) {
    return editors.join(MENTIONS_SEPARATOR);
  }

  return;
};

const getAuthorMentions = (testResults: TestResults) => {
  const {
    errors: { approvalErrors },
    authors
  } = testResults;

  if (authors && approvalErrors.isAuthorApprovedError) {
    return authors.join(MENTIONS_SEPARATOR);
  }

  return;
};

const _getMentions = (
  _getEditorMentions: typeof getEditorMentions,
  _getAuthorMentions: typeof getAuthorMentions
) => (testResults: TestResults) => {
  const editorMentions = _getEditorMentions(testResults);
  const authorMentions = _getAuthorMentions(testResults);
  // filtering Boolean prevents trailing space
  return [editorMentions, authorMentions]
    .filter(Boolean)
    .join(MENTIONS_SEPARATOR);
};

const getMentions = _getMentions(getEditorMentions, getAuthorMentions);

export const _main_ = async () => {
  // Verify correct environment and request context
  requireEvent();
  requirePullNumber();
  const pr = await requirePr();

  // Collect the changes made in the given PR from base <-> head for eip files
  const files = await requireFiles(pr);
  if (pr.changed_files !== 1 || files.length !== 1) {
    throw "sorry only 1 file is supported right now";
  }
  const file = files[0] as File;

  // Collect errors for each file
  const dirtyTestResults = await testFile(file);
  // Apply independent purifiers
  const primedPurifiers = [
    statusChangeAllowedPurifier(dirtyTestResults),
    editorApprovalPurifier(dirtyTestResults),
    EIP1Purifier(dirtyTestResults)
  ];
  // Purify the dirty results
  const testResults = innerJoinAncestors(dirtyTestResults, primedPurifiers);
  const errors = getAllTruthyObjectPaths(testResults.errors).map((path) =>
    get(testResults.errors, path)
  );

  if (errors.length === 0) {
    console.log("passed!");
    return;
  }

  // collect mentions and post message comment
  const mentions = getMentions(testResults);
  await requestReviewers(mentions.split(" "));
  await postComment(errors, mentions);

  const message = `failed to pass tests with the following errors:\n\t- ${errors.join(
    "\n\t- "
  )}`;
  console.log(message);
  return setFailed(message);
};

export const main = async () => {
  const isTest = process.env.NODE_ENV === NodeEnvs.test;

  // allows for easier debugging when developing / testing
  if (isTest) return await _main_();

  try {
    return await _main_();
  } catch (error) {
    console.log(`An Exception Occured While Linting: \n${error}`);
    setFailed(error.message);
    await postComment([error.message]);
    throw error
  }
};

export const _TESTS_ = {
  getEditorMentions,
  getAuthorMentions,
  _getMentions
};
