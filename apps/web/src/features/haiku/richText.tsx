// Übersetzter Satz mit eingebetteten Knoten (Code, Fettes, Links): `{name}` im Text wird durch `nodes.name` ersetzt.
// So bleibt ein Satz EIN Übersetzungs-Schlüssel, statt ihn um die Knoten herum in Bruchstücke zu zerlegen.
import { t } from "@nyxos/shared";
import { Fragment, type ReactNode } from "react";

export function tRich(de: string, nodes: Record<string, ReactNode>): ReactNode {
  return t(de)
    .split(/(\{\w+\})/g)
    .map((part, i) => {
      const key = /^\{(\w+)\}$/.exec(part)?.[1];
      return <Fragment key={i}>{key !== undefined && key in nodes ? nodes[key] : part}</Fragment>;
    });
}
