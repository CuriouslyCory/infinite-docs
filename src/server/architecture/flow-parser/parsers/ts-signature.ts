import * as ts from "typescript";

import {
  type ParsedFlow,
  type ParseFlowSpecResult,
} from "../shared";

/**
 * TypeScript-signature loader. Materializes one Flow per callable declared in
 * the pasted source — top-level function declarations, arrow/function consts,
 * and the methods of interfaces and classes. Each is the analog of an OpenAPI
 * operation for a code-level Component (a Module, Class, or Service): the
 * routable unit other code calls. Interaction is REQUEST (the caller depends on
 * the owner; ADR-0023).
 *
 * Parsing is SYNTAX-ONLY: `ts.createSourceFile` builds an AST with no
 * `Program`, no type-checker, no `CompilerHost` — so it never touches the
 * filesystem, resolves an import, or executes anything. On UNTRUSTED source it
 * produces a best-effort AST (error nodes, never a throw). Only top-level
 * statements and one level into interface/class bodies are walked, so the cost
 * is bounded by the (already byte-capped) source, not by nesting depth.
 */

const MAX_DECLARATIONS = 500;

export function parseTsSignature(source: string): ParseFlowSpecResult {
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      "spec.ts",
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
    );
  } catch {
    return {
      parseError: "Couldn't parse spec as TypeScript signatures.",
    };
  }

  const flows: ParsedFlow[] = [];
  const overflowed = collectCallables(sourceFile, flows);
  if (overflowed) {
    return {
      parseError: `Couldn't parse spec as TypeScript signatures — declaration count exceeds the cap (${MAX_DECLARATIONS}).`,
    };
  }
  return { flows };
}

// Returns true once the declaration cap overflows.
function collectCallables(sourceFile: ts.SourceFile, flows: ParsedFlow[]): boolean {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      if (pushCallable(flows, sourceFile, stmt.name.text, stmt)) return true;
      continue;
    }

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          ts.isIdentifier(decl.name)
        ) {
          if (pushCallable(flows, sourceFile, decl.name.text, init)) return true;
        }
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      const ownerName = stmt.name?.text ?? "(anonymous)";
      for (const member of stmt.members) {
        if (
          (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) &&
          member.name
        ) {
          const key = `${ownerName}.${member.name.getText(sourceFile)}`;
          if (pushCallable(flows, sourceFile, key, member, member.name.getText(sourceFile))) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function pushCallable(
  flows: ParsedFlow[],
  sourceFile: ts.SourceFile,
  key: string,
  node: ts.SignatureDeclaration,
  title = key,
): boolean {
  if (flows.length >= MAX_DECLARATIONS) return true;
  flows.push({
    kind: "FUNCTION_CALL",
    key,
    title,
    interaction: "REQUEST",
    signature: {
      parameters: node.parameters.map((p) => p.getText(sourceFile)),
      returnType: node.type ? node.type.getText(sourceFile) : null,
      typeParameters: node.typeParameters?.map((t) => t.getText(sourceFile)),
    },
  });
  return false;
}
