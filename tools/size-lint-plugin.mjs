const functions = "FunctionDeclaration, FunctionExpression, ArrowFunctionExpression"
const suiteNames = new Set(["describe", "suite"])
const scenarioNames = new Set(["it", "test"])
const testFile = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|[/\\]e2e[/\\])/u

/** @typedef {Extract<Parameters<import("oxlint/plugins-dev").RuleTester["run"]>[1], { create: unknown }>} LintRule */
/** @typedef {Parameters<LintRule["create"]>[0]} Context */
/** @typedef {ReturnType<LintRule["create"]>} Visitors */
/** @typedef {Parameters<NonNullable<Visitors[string]>>[0]} AstNode */
/** @typedef {Parameters<NonNullable<Visitors["FunctionDeclaration" | "ArrowFunctionExpression"]>>[0]} FunctionNode */

/** @param {FunctionNode} node
 * @param {Set<string>} names */
function registered(node, names) {
    const call = node.parent
    if (call.type !== "CallExpression" || !call.arguments.includes(node)) return false
    /** @type {AstNode} */
    let callee = call.callee
    while (callee.type === "MemberExpression" || callee.type === "CallExpression") {
        if (callee.type === "MemberExpression") {
            if (!callee.computed && names.has(callee.property.name)) return true
            callee = callee.object
        } else {
            callee = callee.callee
        }
    }
    return callee.type === "Identifier" && names.has(callee.name)
}

/** @param {FunctionNode} node */
function isFixture(node) {
    const call = node.parent
    return (
        call.type === "CallExpression" &&
        call.callee.type === "Identifier" &&
        /(?:Test|Fixture|Database)$|^with[A-Z]/u.test(call.callee.name)
    )
}

/** @param {FunctionNode} node
 * @param {Context["sourceCode"]} sourceCode
 * @returns {[number, number]} */
function declarationRange(node, sourceCode) {
    /** @type {AstNode} */
    let declaration = node
    const parent = node.parent
    if (parent.type === "VariableDeclarator" && parent.init === node && parent.id.type === "Identifier") {
        declaration = parent
        const group = parent.parent
        if (group.type === "VariableDeclaration" && group.declarations.length === 1) declaration = group
    }
    if (
        parent.type === "Property" &&
        parent.parent.type === "ObjectExpression" &&
        !parent.computed &&
        parent.kind === "init"
    )
        declaration = parent
    const separator = sourceCode.getTokenAfter(declaration)
    return [declaration.range[0], separator?.value === "," ? separator.range[1] : declaration.range[1]]
}

/** @param {Parameters<NonNullable<Visitors["Property"]>>[0]} node */
function passiveProperty(node) {
    if (node.parent.type !== "ObjectExpression" || node.computed || node.kind !== "init") return false
    return node.value.type === "Identifier" || node.value.type === "Literal"
}

/** @param {AstNode} node
 * @param {string} name */
function effectCall(node, name) {
    return (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Effect" &&
        node.callee.property.name === name
    )
}

/** @param {FunctionNode} node */
function isHarness(node) {
    const parent = node.parent
    if (effectCall(parent, "gen")) return true
    if (parent.type !== "Property" || parent.computed || parent.key.type !== "Identifier" || parent.key.name !== "try")
        return false
    return parent.parent.type === "ObjectExpression" && effectCall(parent.parent.parent, "tryPromise")
}

/** @param {Context["sourceCode"]} sourceCode
 * @param {Parameters<Context["sourceCode"]["getTokens"]>[0]} node
 * @param {Array<[number, number]>} excluded */
function tokenLines(sourceCode, node, excluded = []) {
    const lines = new Set()
    for (const token of sourceCode.getTokens(node)) {
        if (excluded.some(([start, end]) => token.range[0] >= start && token.range[1] <= end)) continue
        for (let line = token.loc.start.line; line <= token.loc.end.line; line += 1)
            if ((sourceCode.lines[line - 1] ?? "").trim() !== "") lines.add(line)
    }
    return lines
}

/** @param {{ maximum: number, ceiling?: number, file?: boolean }} limits
 * @returns {LintRule} */
function rule({ maximum, ceiling, file = false }) {
    return {
        meta: {
            type: "suggestion",
            docs: {
                description: "Keep execution logic small without splitting declarations or test catalogs."
            },
            schema: [],
            messages: {
                size: "{{kind}} has {{lines}} lines of logic; the limit is {{maximum}}. Simplify its responsibilities."
            }
        },
        create(context) {
            const catalog = testFile.test(context.filename)
            if (file && catalog) return {}
            /** @type {Array<{ node: FunctionNode, excluded: Array<[number, number]>, scenario: boolean }>} */
            const stack = []
            const fileLines = new Set()
            const sourceCode = context.sourceCode
            /** @param {FunctionNode} node */
            function enter(node) {
                if (node.body === null) return
                const parent = stack.at(-1)
                if (parent !== undefined) parent.excluded.push(declarationRange(node, sourceCode))
                const scenario =
                    catalog &&
                    (registered(node, scenarioNames) ||
                        (parent?.scenario === true && (isFixture(node) || isHarness(node))))
                stack.push({ node, excluded: [], scenario })
            }
            /** @param {FunctionNode} node */
            function exit(node) {
                if (node.body === null) return
                const frame = stack.pop()
                if (frame === undefined) return
                if (catalog && (frame.scenario || registered(frame.node, suiteNames))) return
                const lines = tokenLines(sourceCode, node.body, frame.excluded)
                if (file) {
                    for (const line of lines) fileLines.add(line)
                    return
                }
                if (lines.size <= maximum || (ceiling !== undefined && lines.size > ceiling)) return
                context.report({
                    node: frame.node,
                    messageId: "size",
                    data: { kind: "Function", lines: lines.size, maximum }
                })
            }
            return {
                [functions]: enter,
                [`${functions}:exit`]: exit,
                Property(node) {
                    const frame = stack.at(-1)
                    if (frame === undefined || !passiveProperty(node)) return
                    const separator = sourceCode.getTokenAfter(node)
                    frame.excluded.push([node.range[0], separator?.value === "," ? separator.range[1] : node.range[1]])
                },
                "TSTypeAliasDeclaration, TSInterfaceDeclaration, TSTypeAnnotation, TSTypeParameterDeclaration, TSTypeParameterInstantiation"(
                    node
                ) {
                    stack.at(-1)?.excluded.push(node.range)
                },
                /** @param {Extract<AstNode, { type: "TSAsExpression" | "TSSatisfiesExpression" | "TSTypeAssertion" }>} node */
                "TSAsExpression, TSSatisfiesExpression, TSTypeAssertion"(node) {
                    stack.at(-1)?.excluded.push(node.typeAnnotation.range)
                },
                "ExpressionStatement, IfStatement, ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement, SwitchStatement, TryStatement, ThrowStatement"(
                    node
                ) {
                    if (!file || stack.length !== 0) return
                    for (const line of tokenLines(sourceCode, node)) fileLines.add(line)
                },
                "Program:exit"(node) {
                    if (!file || fileLines.size <= maximum) return
                    context.report({
                        node,
                        messageId: "size",
                        data: { kind: "File", lines: fileLines.size, maximum }
                    })
                }
            }
        }
    }
}

export default {
    meta: { name: "umwelt-size" },
    rules: {
        "function-lines": rule({ maximum: 80 }),
        "function-lines-warning": rule({ maximum: 50, ceiling: 80 }),
        "file-logic-lines-warning": rule({ maximum: 300, file: true })
    }
}
