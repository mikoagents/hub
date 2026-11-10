import { useEffect, useState } from "react";
import { FlowDiagram } from "../../components/app/flow-diagram.js";
import type { TriggerManifest } from "./sdk.js";
import { triggerFlowDiagram } from "./flow.js";

export function TriggerFlow({ manifest }: { manifest: TriggerManifest }) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 640px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <FlowDiagram
      source={triggerFlowDiagram(manifest, wide ? "LR" : "TB")}
      label={`Workflow for ${manifest.name}`}
    />
  );
}
