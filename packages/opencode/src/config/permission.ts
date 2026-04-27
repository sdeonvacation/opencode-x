import { Schema, SchemaGetter } from "effect"
import z from "zod"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const Action = Schema.Literals(["ask", "allow", "deny"])
  .annotate({ identifier: "PermissionActionConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Action = Schema.Schema.Type<typeof Action>

export const Object = Schema.Record(Schema.String, Action)
  .annotate({ identifier: "PermissionObjectConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Object = Schema.Schema.Type<typeof Object>

export const Rule = Schema.Union([Action, Object])
  .annotate({ identifier: "PermissionRuleConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Rule = Schema.Schema.Type<typeof Rule>

const InputObject = Schema.StructWithRest(
  Schema.Struct({
    read: Schema.optional(Rule),
    edit: Schema.optional(Rule),
    glob: Schema.optional(Rule),
    grep: Schema.optional(Rule),
    list: Schema.optional(Rule),
    bash: Schema.optional(Rule),
    task: Schema.optional(Rule),
    external_directory: Schema.optional(Rule),
    todowrite: Schema.optional(Action),
    question: Schema.optional(Action),
    webfetch: Schema.optional(Action),
    websearch: Schema.optional(Action),
    codesearch: Schema.optional(Action),
    lsp: Schema.optional(Rule),
    doom_loop: Schema.optional(Action),
    skill: Schema.optional(Rule),
  }),
  [Schema.Record(Schema.String, Rule)],
)

const InputSchema = Schema.Union([Action, InputObject])

const normalizeInput = (input: Schema.Schema.Type<typeof InputSchema>): Schema.Schema.Type<typeof InputObject> =>
  typeof input === "string" ? { "*": input } : input

const InfoZod = z
  .union([
    zod(Action),
    z.intersection(
      z.record(z.string(), zod(Rule)),
      z
        .object({
          read: zod(Rule).optional(),
          edit: zod(Rule).optional(),
          glob: zod(Rule).optional(),
          grep: zod(Rule).optional(),
          list: zod(Rule).optional(),
          bash: zod(Rule).optional(),
          task: zod(Rule).optional(),
          external_directory: zod(Rule).optional(),
          todowrite: zod(Action).optional(),
          question: zod(Action).optional(),
          webfetch: zod(Action).optional(),
          websearch: zod(Action).optional(),
          codesearch: zod(Action).optional(),
          lsp: zod(Rule).optional(),
          doom_loop: zod(Action).optional(),
          skill: zod(Rule).optional(),
        })
        .catchall(zod(Rule)),
    ),
  ])
  .transform(normalizeInput)

export const Info = InputSchema.pipe(
  Schema.decodeTo(InputObject, {
    decode: SchemaGetter.transform(normalizeInput),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)
  .annotate({ identifier: "PermissionConfig" })
  .pipe(withStatics(() => ({ zod: InfoZod })))

type _Info = Schema.Schema.Type<typeof InputObject>
export type Info = { -readonly [K in keyof _Info]: _Info[K] }
