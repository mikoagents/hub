import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { JsonValue } from "../../config/compiler.js";
import {
  type TriggerProvider,
  type TriggerProviderMatch,
  type TriggerProviderReactionState,
} from "../index.js";
import type { GitHubAuth } from "../../auth/github.js";
import {
  agentFailureNotice,
  isExecutionLimitDenial,
  missingBillingUrl,
} from "../failure-notice.js";
import type { GitHubReplyClient } from "./reply.js";
import {
  matchTriggers,
  readGitHubInvocationMessage,
  readGitHubInvocationParserMessage,
  readGitHubMention,
} from "./match.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import {
  IssueCommentPayloadSchema,
  IssuesPayloadSchema,
  NormalizedGitHubEventSchema,
  PullRequestPayloadSchema,
  PullRequestReviewCommentPayloadSchema,
} from "../../auth/github-events.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { classifyGitHubEvent, GITHUB_TRIGGER_SOURCE_NAMES } from "./classification.js";
import { completedWorkflowRun, githubEventKey } from "./workflow-run.js";
import {
  currentPullRequest,
  matchPullRequestReadiness,
  withinRepairLimit,
  type PullRequestReadiness,
  type ReadPullRequest,
  type SyncCompletionLabel,
} from "./pull-request-gate.js";

export interface GitHubReactionClient {
  /** Returns null when the installation or reaction target is unavailable (GitHub 404). */
  createReaction(input: {
    installationId: number;
    repo: string;
    subject: GitHubReactionSubject;
    content: GitHubReactionContent;
  }): Promise<GitHubCreatedReaction | null>;
  deleteReaction(input: {
    installationId: number;
    repo: string;
    subject: GitHubReactionSubject;
    reactionId: number;
  }): Promise<void>;
}

export interface GitHubCreatedReaction {
  id: number;
}

export type GitHubReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "eyes";

export interface GitHubMergeData {
  github: {
    repair_input_key?: string;
    workflow_run?: {
      id: number;
      run_attempt: number;
      head_sha: string;
      conclusion: string | null;
      name?: string;
      html_url?: string;
    };
    delivery_id: string;
    event_name: string;
    repository: { full_name: string };
    received_at: string;
    item: GitHubContextItem | null;
    pull_request: { draft: boolean | null; head_sha: string | null } | null;
  };
}

interface GitHubContextItem {
  type: "issue" | "pull_request";
  number: number | null;
  title: string | null;
  body: string | null;
  url: string | null;
  author: { login: string } | null;
}

export function createGitHubReactionClient(
  auth: Pick<GitHubAuth, "createInstallationOctokit">,
): GitHubReactionClient {
  return {
    async createReaction(input) {
      try {
        const [owner, repo] = splitRepo(input.repo);
        const octokit = await auth.createInstallationOctokit(input.installationId);
        if (input.subject.kind === "item") {
          const response = await octokit.request(
            "POST /repos/{owner}/{repo}/issues/{issue_number}/reactions",
            { owner, repo, issue_number: input.subject.issueNumber, content: input.content },
          );
          return { id: response.data.id };
        }
        if (input.subject.kind === "issue_comment") {
          const response = await octokit.request(
            "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
            { owner, repo, comment_id: input.subject.commentId, content: input.content },
          );
          return { id: response.data.id };
        }
        const response = await octokit.request(
          "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
          { owner, repo, comment_id: input.subject.commentId, content: input.content },
        );
        return { id: response.data.id };
      } catch (error) {
        // GitHub also uses 404 when this installation can no longer access the target.
        // A cosmetic reaction cannot be delivered there; settle it without retrying.
        if (isUnavailableReactionTarget(error)) return null;
        throw error;
      }
    },
    async deleteReaction(input) {
      try {
        const [owner, repo] = splitRepo(input.repo);
        const octokit = await auth.createInstallationOctokit(input.installationId);
        if (input.subject.kind === "item") {
          await octokit.request(
            "DELETE /repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}",
            { owner, repo, issue_number: input.subject.issueNumber, reaction_id: input.reactionId },
          );
        } else if (input.subject.kind === "issue_comment") {
          await octokit.request(
            "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}",
            { owner, repo, comment_id: input.subject.commentId, reaction_id: input.reactionId },
          );
        } else {
          await octokit.request(
            "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id}",
            { owner, repo, comment_id: input.subject.commentId, reaction_id: input.reactionId },
          );
        }
      } catch (error) {
        if (isUnavailableReactionTarget(error)) return;
        throw error;
      }
    },
  };
}

function isUnavailableReactionTarget(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "status") === 404;
}

export type GitHubReactionSubject =
  | { kind: "item"; issueNumber: number }
  | { kind: "issue_comment"; commentId: number }
  | { kind: "pull_request_review_comment"; commentId: number };

export interface GitHubTriggerContext {
  readiness?: PullRequestReadiness;
  provider: "github";
  organizationId: string;
  target: { installationId: number; repository: string };
  event: GitHubMergeData;
  reactionSubject: GitHubReactionSubject | null;
}

interface GitHubReactionState {
  readonly [key: string]: JsonValue;
  readonly reactionId: number;
}

export function createGitHubTriggerProvider(options: {
  readPullRequest?: ReadPullRequest;
  syncCompletionLabel?: SyncCompletionLabel;
  resolveWorkflowPullRequest?: (
    event: NormalizedGitHubEvent,
  ) => Promise<{ number: number } | undefined>;
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  reactions: GitHubReactionClient;
  comments?: GitHubReplyClient;
  billingUrlForOrganization?: (organizationId: string) => Promise<string>;
}): TriggerProvider<"github", GitHubTriggerContext> {
  return {
    name: "github",
    eventNames: GITHUB_TRIGGER_SOURCE_NAMES,
    async match(externalTrigger) {
      let event = NormalizedGitHubEventSchema.parse(externalTrigger.payload);
      const completed = completedWorkflowRun(event);
      if (event.type === "workflow_run") {
        if (completed === undefined) return "trigger_filters_rejected";
        if (completed.workflow_run.pull_requests.length !== 1) {
          const pull = await options.resolveWorkflowPullRequest?.(event);
          if (pull === undefined) return "trigger_filters_rejected";
          event = {
            ...event,
            payload: {
              ...event.payload,
              workflow_run: {
                ...completed.workflow_run,
                pull_requests: [pull],
              },
            },
          };
        }
      }
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (
        !stored.configuration.triggers.some((candidate) =>
          [externalTrigger.source, classifyGitHubEvent(event).semanticEvent].includes(candidate.on),
        )
      )
        return "no_trigger_for_source";
      const matches: TriggerProviderMatch<GitHubTriggerContext>[] = [];

      for (const match of matchTriggers(
        stored.configuration,
        event,
        externalTrigger.connectionId,
      )) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined)
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        const triggerContext: GitHubTriggerContext = {
          provider: "github",
          organizationId: externalTrigger.organizationId,
          target: { installationId: event.installationId, repository: event.repo },
          event: buildGitHubMergeData(event),
          reactionSubject: reactionSubjectForEvent(event),
        };
        const invocation = parseInvocation(
          readGitHubInvocationMessage(event),
          compiledTrigger.inputs,
          readGitHubMention(event, compiledTrigger.filters),
          readGitHubInvocationParserMessage(event, compiledTrigger.filters),
        );
        if (invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
        }
        if (invocation.status === "rejected") {
          matches.push({
            conversation: githubConversation(event),
            triggerName: match.trigger.name,
            triggerContext,
            outputContext: triggerContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
          continue;
        }
        let stateKey: string | undefined;
        const policy = compiledTrigger.coordination?.github_pull_request;
        if (policy !== undefined) {
          const ready = await matchPullRequestReadiness(
            event,
            policy,
            options.readPullRequest,
            options.syncCompletionLabel,
          );
          if (ready === undefined) continue;
          stateKey = ready.key;
          triggerContext.readiness = ready.readiness;
          triggerContext.event.github.repair_input_key = ready.key;
        }
        matches.push({
          ...(stateKey === undefined ? {} : { stateKey }),
          eventKey: githubEventKey(event),
          conversation: githubConversation(event),
          triggerName: match.trigger.name,
          triggerContext,
          outputContext: triggerContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
          invocation,
        });
      }

      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
    async shouldStart(context) {
      if (context.readiness === undefined) return true;
      if (options.readPullRequest === undefined)
        throw new Error("GitHub readiness reader unavailable");
      const snapshot = await options.readPullRequest({
        ...context.target,
        number: context.readiness.number,
        ...(context.readiness.repairLimit === undefined
          ? {}
          : { repairLimit: context.readiness.repairLimit }),
      });
      return (
        currentPullRequest(snapshot, context.readiness.headSha) &&
        withinRepairLimit(snapshot, context.readiness.repairLimit)
      );
    },
    async materializeContext(launch) {
      return launch.triggerContext.event;
    },
    async onDispatchAccepted(triggerContext, _outputContext, reactionState) {
      if (triggerContext.reactionSubject === null) return null;
      if (githubReactionId(reactionState) !== undefined) return reactionState;
      const reaction = await options.reactions.createReaction({
        installationId: triggerContext.target.installationId,
        repo: triggerContext.target.repository,
        subject: triggerContext.reactionSubject,
        content: "eyes",
      });
      return reaction === null ? null : ({ reactionId: reaction.id } satisfies GitHubReactionState);
    },
    async onAgentExecutionCompleted(triggerContext, _outputContext, _result, reactionState) {
      // Older accepted draft runs may still finish after draft filtering is enabled.
      if (triggerContext.event.github?.pull_request?.draft === true) {
        await deletePreviousReaction(
          options.reactions,
          triggerContext,
          githubReactionId(reactionState),
        );
        return null;
      }
      return reactToLifecycle(options.reactions, triggerContext, "+1", reactionState);
    },
    async onAgentExecutionFailed(triggerContext, _outputContext, reason, reactionState) {
      if (isExecutionLimitDenial(reason) && triggerContext.event.github.item?.number != null) {
        if (options.comments === undefined) throw new Error("GitHub comment client unavailable");
        const [owner, repo] = splitRepo(triggerContext.target.repository);
        await deletePreviousReaction(
          options.reactions,
          triggerContext,
          githubReactionId(reactionState),
        );
        await options.comments.createIssueComment({
          installationId: triggerContext.target.installationId,
          owner,
          repo,
          issueNumber: triggerContext.event.github.item.number,
          body: await agentFailureNotice(
            reason,
            triggerContext.organizationId,
            options.billingUrlForOrganization ?? missingBillingUrl,
          ),
        });
        return null;
      }
      return reactToLifecycle(options.reactions, triggerContext, "-1", reactionState);
    },
    async onMachineTerminated(triggerContext, _reason, reactionState) {
      return reactToLifecycle(options.reactions, triggerContext, "-1", reactionState);
    },
  };
}

function buildGitHubMergeData(event: NormalizedGitHubEvent): GitHubMergeData {
  const classified = classifyGitHubEvent(event);
  const workflow = completedWorkflowRun(event)?.workflow_run;
  return {
    github: {
      ...(workflow === undefined
        ? {}
        : {
            workflow_run: {
              id: workflow.id,
              run_attempt: workflow.run_attempt,
              head_sha: workflow.head_sha,
              conclusion: workflow.conclusion,
              ...(workflow.name === undefined ? {} : { name: workflow.name }),
              ...(workflow.html_url === undefined ? {} : { html_url: workflow.html_url }),
            },
          }),
      delivery_id: event.id,
      event_name: event.type,
      repository: { full_name: event.repo },
      received_at: event.createdAt,
      item: classified.item,
      pull_request:
        classified.pullRequest === null
          ? null
          : {
              draft: classified.pullRequest.draft,
              head_sha: classified.pullRequest.headSha,
            },
    },
  };
}

async function reactToLifecycle(
  reactions: GitHubReactionClient,
  triggerContext: GitHubTriggerContext,
  content: GitHubReactionContent,
  reactionState?: TriggerProviderReactionState,
): Promise<GitHubReactionState | null> {
  if (triggerContext.reactionSubject === null) {
    return null;
  }

  await deletePreviousReaction(reactions, triggerContext, githubReactionId(reactionState));

  const reaction = await reactions.createReaction({
    installationId: triggerContext.target.installationId,
    repo: triggerContext.target.repository,
    subject: triggerContext.reactionSubject,
    content,
  });
  return reaction === null ? null : ({ reactionId: reaction.id } satisfies GitHubReactionState);
}

async function deletePreviousReaction(
  reactions: GitHubReactionClient,
  triggerContext: GitHubTriggerContext,
  reactionId: number | undefined,
): Promise<void> {
  if (triggerContext.reactionSubject === null || reactionId === undefined) {
    return;
  }

  await reactions.deleteReaction({
    installationId: triggerContext.target.installationId,
    repo: triggerContext.target.repository,
    subject: triggerContext.reactionSubject,
    reactionId,
  });
}

function githubReactionId(state: TriggerProviderReactionState | undefined): number | undefined {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return undefined;
  const reactionId = state["reactionId"];
  return typeof reactionId === "number" && Number.isSafeInteger(reactionId)
    ? reactionId
    : undefined;
}

function reactionSubjectForEvent(event: NormalizedGitHubEvent): GitHubReactionSubject | null {
  if (event.type === "issues") {
    const payload = IssuesPayloadSchema.parse(event.payload);
    return payload.issue?.number === undefined
      ? null
      : { kind: "item", issueNumber: payload.issue.number };
  }

  if (event.type === "pull_request") {
    const payload = PullRequestPayloadSchema.parse(event.payload);
    return payload.pull_request?.number === undefined
      ? null
      : { kind: "item", issueNumber: payload.pull_request.number };
  }

  if (event.type === "issue_comment") {
    const payload = IssueCommentPayloadSchema.parse(event.payload);
    return payload.comment?.id === undefined
      ? null
      : { kind: "issue_comment", commentId: payload.comment.id };
  }

  if (event.type === "pull_request_review_comment") {
    const payload = PullRequestReviewCommentPayloadSchema.parse(event.payload);
    return payload.comment?.id === undefined
      ? null
      : { kind: "pull_request_review_comment", commentId: payload.comment.id };
  }

  return null;
}

function splitRepo(fullName: string): [owner: string, repo: string] {
  const [owner, repo] = fullName.split("/");

  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    throw new Error(`invalid GitHub repo full name: ${fullName}`);
  }

  return [owner, repo];
}

function githubConversation(
  event: NormalizedGitHubEvent,
): import("../continuation.js").Conversation | null {
  const item =
    event.type === "workflow_run"
      ? classifyGitHubEvent(event).item
      : (event.payload["pull_request"] ?? event.payload["issue"]);
  if (typeof item !== "object" || item === null) return null;
  const number: unknown = Reflect.get(item, "number");
  if (typeof number !== "number") return null;
  const url: unknown = Reflect.get(item, "html_url");
  return {
    key: JSON.stringify(["github", event.repositoryId, number]),
    label: `${event.repo}#${String(number)}`,
    ...(typeof url === "string" ? { url } : {}),
  };
}
