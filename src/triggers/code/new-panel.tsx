/* oxlint-disable eslint-plugin-react-perf/jsx-no-jsx-as-prop -- guide cards compose shared disclosure and copy controls */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- organization paths use the server-resolved tenant slug */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Card } from "../../components/app/card.js";
import { CopyBlock } from "../../components/app/copy-field.js";
import { Disclosure } from "../../components/app/disclosure.js";
import { PageHeader } from "../../components/app/page.js";
import { Steps } from "../../components/app/steps.js";
import { Button } from "../../components/ui/button.js";
import { useRouteTenant } from "../../projects/context.js";
import { triggerStarter } from "./starter.js";

export function NewTriggerPanel() {
  const { organization } = useRouteTenant();
  const [origin, setOrigin] = useState("<hub-url>");
  const [exampleOpen, setExampleOpen] = useState(false);
  const [runnerOpen, setRunnerOpen] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const url = `'${origin.replaceAll("'", "'\\''")}'`;
  return (
    <>
      <PageHeader
        title="New trigger"
        description="Choose when it runs. Write what it does. Deploy it to Hub."
      />
      <Steps>
        <Card
          title="Write your workflow"
          description="Start with a working script, then add your conditions, loops and API calls."
        >
          <CopyBlock
            label="Create a project"
            action="Copy command"
            value="paseo-hub trigger init my-trigger"
          />
          <p className="text-sm text-muted-foreground">
            Edit <code>my-trigger/trigger.ts</code>. <code>on</code> declares the events that start
            it;
            <code> run(ctx)</code> is the code that runs. The starter has an on-demand entry so you
            can try it immediately.
          </p>
          <Disclosure
            id="trigger-starter"
            title="See the starter script"
            open={exampleOpen}
            onOpenChange={setExampleOpen}
          >
            <CopyBlock label="trigger.ts" action="Copy code" value={triggerStarter("my-trigger")} />
          </Disclosure>
        </Card>
        <Card
          title="Connect to your Hub"
          description="Use an organization API key for deployment and a runner to execute your scripts."
        >
          <p className="text-sm text-muted-foreground">
            Create an API key with Install configuration and Validate configuration permissions.
            Save its value in a private file called <code>hub.key</code> outside{" "}
            <code>my-trigger</code>.
          </p>
          <div>
            <Button variant="outline" asChild>
              <Link to={`/o/${organization.slug}/settings/api-keys` as never}>Manage API keys</Link>
            </Button>
          </div>
          <Disclosure
            id="trigger-runner-setup"
            title="Set up a runner once"
            description="Skip this if your chosen runner is already running."
            open={runnerOpen}
            onOpenChange={setRunnerOpen}
          >
            <div className="grid gap-4">
              <p className="text-sm text-muted-foreground">
                The starter uses a runner named <code>local</code>. Run these commands on the
                machine that will execute your script and leave the runner running. A Miko daemon is
                needed when your code calls an agent.
              </p>
              <CopyBlock
                label="Start the local runner"
                action="Copy commands"
                value={`paseo-hub trigger runner-enroll local --url ${url} --token-file ./hub.key --out ./runner.key\npaseo-hub trigger runner --url ${url} --token-file ./runner.key --directory ./runner-data`}
              />
            </div>
          </Disclosure>
        </Card>
        <Card
          title="Deploy and try it"
          description="Check the script, deploy it, then open your Trigger and choose Run now."
        >
          <CopyBlock
            label="Check and deploy"
            action="Copy commands"
            value={`paseo-hub trigger check my-trigger/trigger.ts\npaseo-hub trigger deploy my-trigger/trigger.ts --url ${url} --token-file ./hub.key`}
          />
          <p className="text-sm text-muted-foreground">
            Results and logs appear in the Trigger’s Run history. After editing the script, deploy
            again with the same name to update this Trigger and keep its history.
          </p>
          <div>
            <Button variant="outline" asChild>
              <Link to={`/o/${organization.slug}/triggers` as never}>View triggers</Link>
            </Button>
          </div>
        </Card>
      </Steps>
    </>
  );
}
