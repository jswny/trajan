import { Schema } from "effect";

export const execName = "exec";
export const ExecInput = Schema.Struct({ code: Schema.NonEmptyString });
