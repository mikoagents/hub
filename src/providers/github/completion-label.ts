import type { GitHubAuth } from "../../auth/github.js";
import type { SyncCompletionLabel } from "../../triggers/github/pull-request-gate.js";

/** Opt-in provider authority, restricted to the configured label on the event's PR. */
export function createCompletionLabelWriter(
  auth: Pick<GitHubAuth, "createInstallationOctokit">,
): SyncCompletionLabel {
  return async (target, headSha, label, complete) => {
    const [owner, repo] = target.repository.split("/");
    if (owner === undefined || repo === undefined) throw new Error("Invalid GitHub repository");
    const octokit = await auth.createInstallationOctokit(target.installationId);
    const pull = () =>
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: target.number,
      });
    const current = (await pull()).data;
    // A delayed event must never overwrite a newer head's result.
    if (current.head.sha !== headSha) return;
    const present = current.labels.some((item) => item.name === label.name);
    const eligible = complete && activePull(current, headSha);
    const remove = async (name = label.name) => {
      try {
        await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
          owner,
          repo,
          issue_number: target.number,
          name,
        });
      } catch (error) {
        if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
      }
    };
    if (!eligible) {
      if (present) await remove();
      if ((await pull()).data.labels.some((item) => item.name === label.name))
        throw new Error("GitHub completion label removal readback mismatch");
      return;
    }
    for (const name of label.exclusive_with ?? []) {
      if (current.labels.some((item) => item.name === name)) await remove(name);
    }
    if (!present) {
      await ensureDefinition(octokit, owner, repo, label);
      const before = (await pull()).data;
      if (!activePull(before, headSha)) return;
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner,
        repo,
        issue_number: target.number,
        labels: [label.name],
      });
    }
    const after = (await pull()).data;
    if (!activePull(after, headSha)) {
      await remove();
      return;
    }
    if (!after.labels.some((item) => item.name === label.name))
      throw new Error("GitHub completion label readback mismatch");
    if (after.labels.some((item) => label.exclusive_with?.includes(item.name ?? "")))
      throw new Error("GitHub completion label exclusivity readback mismatch");
  };
}

async function ensureDefinition(
  octokit: Awaited<ReturnType<GitHubAuth["createInstallationOctokit"]>>,
  owner: string,
  repo: string,
  label: Parameters<SyncCompletionLabel>[2],
): Promise<void> {
  try {
    await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
      owner,
      repo,
      name: label.name,
    });
  } catch (error) {
    if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
    try {
      await octokit.request("POST /repos/{owner}/{repo}/labels", {
        owner,
        repo,
        name: label.name,
        color: label.color,
        description: label.description,
      });
    } catch (created) {
      if (!(created instanceof Error && "status" in created && created.status === 422))
        throw created;
      // A concurrent creator is acceptable only if the named definition now exists.
      await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
        owner,
        repo,
        name: label.name,
      });
    }
  }
}

function activePull(
  pull: { head: { sha: string }; state: string; draft?: boolean | null | undefined },
  head: string,
): boolean {
  return pull.head.sha === head && pull.state === "open" && !pull.draft;
}
