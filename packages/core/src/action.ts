import type { EntityRef } from "./entity.js";

export type ActionType =
  | "click"
  | "fill"
  | "select"
  | "hover"
  | "keyboard"
  | "navigate"
  | "composite";

export interface Condition {
  readonly description: string;
  readonly check: ConditionCheck;
}

export type ConditionCheck =
  | { type: "element_visible"; selector: string }
  | { type: "element_absent"; selector: string }
  | { type: "text_matches"; selector: string; pattern: string }
  | { type: "url_matches"; pattern: string }
  | {
      type: "entity_state";
      entityRef: EntityRef;
      field: string;
      expected: unknown;
    };

/**
 * An action the runtime has identified as available on one or more entities.
 */
export interface Action {
  readonly id: string;
  readonly name: string;
  readonly type: ActionType;
  readonly targets: string[];
  readonly preconditions: Condition[];
  readonly postconditions: Condition[];
  readonly confidence: number;
}

/**
 * A collection of available actions with convenience query methods.
 */
export class ActionSet {
  readonly actions: readonly Action[];

  constructor(actions: Action[]) {
    this.actions = Object.freeze(actions);
  }

  /** Find actions whose name contains the given string (case-insensitive). */
  named(name: string): Action[] {
    const lower = name.toLowerCase();
    return this.actions.filter((a) => a.name.toLowerCase().includes(lower));
  }

  /** Find actions of a specific type. */
  ofType(type: ActionType): Action[] {
    return this.actions.filter((a) => a.type === type);
  }

  /** Get all action names. */
  names(): string[] {
    return this.actions.map((a) => a.name);
  }

  /** Get the first action, if any. */
  first(): Action | undefined {
    return this.actions[0];
  }

  /** Number of available actions. */
  get count(): number {
    return this.actions.length;
  }
}
