import type { ComponentType, ReactNode } from "react";
import type { SourceConnection, SourceType } from "./model";

// The four kinds of source the Add New Source wizard offers. Canvas is built in (settingsSources.tsx).
// The other kinds plug in here: give them an `AddForm` (shown in the wizard) and optionally `CardExtras`
// (shown inside their connection card, for example course mapping). Until then the wizard and the card
// say "Coming in this release".
//
//   registerSourceUi("gradescope", { AddForm: GradescopeForm, CardExtras: GradescopeCourses });

export interface AddFormProps {
  /** Close the wizard after the source was created. */
  onDone: (source: SourceConnection) => void;
  onCancel: () => void;
}

export interface CardExtrasProps {
  source: SourceConnection;
}

export interface SourceUi {
  AddForm?: ComponentType<AddFormProps>;
  CardExtras?: ComponentType<CardExtrasProps>;
  /** Replaces the card's default authentication line. */
  authNote?: (source: SourceConnection) => ReactNode;
  /** The editor that Settings → Sources opens for ?edit=<id> (the sidebar's Manage). */
  EditDialog?: ComponentType<EditDialogProps>;
}

export interface EditDialogProps {
  source: SourceConnection;
  open: boolean;
  onClose: () => void;
}

export interface SourceTypeInfo {
  type: SourceType;
  label: string;
  description: string;
  /** Read-only providers sign in through the Auth Broker. */
  browserSignIn: boolean;
}

export const SOURCE_TYPES: SourceTypeInfo[] = [
  { type: "canvas", label: "Canvas", description: "PAT or browser-session authentication", browserSignIn: true },
  { type: "website", label: "Course Website", description: "Public or NTLM-protected course site", browserSignIn: false },
  { type: "gradescope", label: "Gradescope", description: "Read-only student assignments and submission facts", browserSignIn: true },
  { type: "prairielearn", label: "PrairieLearn", description: "Configurable student instance · browser sign-in", browserSignIn: true },
];

const registry = new Map<SourceType, SourceUi>();

export function registerSourceUi(type: Exclude<SourceType, "canvas">, ui: SourceUi): void {
  registry.set(type, ui);
}

export function sourceUi(type: SourceType): SourceUi | null {
  return registry.get(type) ?? null;
}

export const COMING_SOON = "Coming in this release";
