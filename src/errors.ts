/** Umwelt's typed failures: in the error channel on the Effect face, thrown on the Promise face. */
import { Schema } from "effect"

const BlockingReason = Schema.Union([
    Schema.Struct({
        kind: Schema.Literals([
            "invalidSchema",
            "invalidUniqueKey",
            "reservedTypeName",
            "duplicateTypeName",
            "immutableWithHistory",
            "uniqueKeyChangeWithObjects",
            "typeRemovedWithObjects"
        ]),
        type: Schema.String
    }),
    Schema.Struct({ kind: Schema.Literal("reservedFieldName"), type: Schema.String, field: Schema.String }),
    Schema.Struct({
        kind: Schema.Literals(["unknownRelationTarget", "relationTargetWithoutUniqueKey"]),
        type: Schema.String,
        field: Schema.String,
        target: Schema.String
    }),
    Schema.Struct({
        kind: Schema.Literals(["ambiguousRelation", "recursiveRelation"]),
        type: Schema.String,
        field: Schema.String
    }),
    /** Run `umwelt create`. */
    Schema.Struct({ kind: Schema.Literal("chainBehindModel") }),
    Schema.Struct({
        kind: Schema.Literals(["chainBroken", "fork", "appliedMigrationChanged"]),
        migration: Schema.String
    }),
    Schema.Struct({ kind: Schema.Literal("migrationMissing"), migration: Schema.String, type: Schema.String })
])
/** Reported in this order: Model, then chain, then Ledger. */
export type BlockingReason = typeof BlockingReason.Type

/** Input fails its type or the Type schema; or has a key the input types do not allow. */
export class ValidationFailed extends Schema.TaggedError<ValidationFailed, { readonly brand: unique symbol }>()(
    "ValidationFailed",
    {
        message: Schema.String
    }
) {}

/**
 * Model and database disagree: Ledger's head is not the chain's head, or Model in code is not what the chain folds to,
 * so `umwelt create` is due. `database` and `code` name each head's Migration id.
 */
export class ModelMismatch extends Schema.TaggedError<ModelMismatch, { readonly brand: unique symbol }>()(
    "ModelMismatch",
    {
        database: Schema.NullOr(Schema.String),
        code: Schema.NullOr(Schema.String)
    }
) {}

export class ConditionRejected extends Schema.TaggedError<ConditionRejected, { readonly brand: unique symbol }>()(
    "ConditionRejected",
    {
        reason: Schema.Literals(["mustExist", "mustNotExist", "mustMatch", "immutable", "unknownId"])
    }
) {}

/** Same Identity twice in one Write list. */
export class DuplicateIdentity extends Schema.TaggedError<DuplicateIdentity, { readonly brand: unique symbol }>()(
    "DuplicateIdentity",
    {}
) {}

/** Strict relation target missing: after a Write list, or after Deploy's Migrations. */
export class MissingTarget extends Schema.TaggedError<MissingTarget, { readonly brand: unique symbol }>()(
    "MissingTarget",
    {
        type: Schema.String,
        identity: Schema.Unknown
    }
) {}

/** Host table references a selected Object through an immediate foreign key. */
export class ReferencedByHost extends Schema.TaggedError<ReferencedByHost, { readonly brand: unique symbol }>()(
    "ReferencedByHost",
    {
        table: Schema.String
    }
) {}

/** Check found blocking reasons; Deploy changed nothing. */
export class Blocked extends Schema.TaggedError<Blocked, { readonly brand: unique symbol }>()("Blocked", {
    reasons: Schema.Array(BlockingReason)
}) {}

/** A step's result fails form after or changes Identity, or a `safe` step finds unfit content: `object` names its Object ID. */
export class MigrationFailed extends Schema.TaggedError<MigrationFailed, { readonly brand: unique symbol }>()(
    "MigrationFailed",
    {
        migration: Schema.String,
        type: Schema.String,
        object: Schema.String,
        cause: Schema.String
    }
) {}
