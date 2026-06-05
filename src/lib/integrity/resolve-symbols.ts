import ts from "typescript";

/**
 * Result of a single-file symbol-resolution analysis.
 *
 * `unresolved` — value-position identifiers a file references that are bound
 * nowhere in the file (no import, no local declaration, no parameter) and are
 * not a known runtime global. These are exactly the names a corrupt file
 * cannot compile against (`TS2304 Cannot find name`, `TS2686 UMD global`).
 *
 * `duplicateFns` — names declared by two or more *top-level* function
 * declarations that each carry a body (`TS2393 Duplicate function
 * implementation`). Overload signatures (multiple declarations, one body) are
 * intentionally not flagged.
 */
export interface ResolutionResult {
  unresolved: string[];
  duplicateFns: string[];
}

/**
 * Runtime globals available without an import. Value-position only — the
 * analysis never inspects type-position identifiers, so TypeScript utility
 * types (Partial, Record, …) and DOM type names deliberately don't appear.
 * Generous on purpose: a missing entry produces a false `unresolved` finding,
 * so we err toward inclusion.
 */
const GLOBALS = new Set<string>([
  // ECMAScript intrinsics
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Math", "JSON", "Date", "RegExp", "Function", "Promise", "Proxy", "Reflect",
  "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Intl",
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError",
  "TypeError", "URIError", "AggregateError",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array", "ArrayBuffer", "SharedArrayBuffer",
  "DataView", "Atomics", "Generator", "GeneratorFunction",
  "Infinity", "NaN", "undefined", "globalThis", "arguments",
  "parseInt", "parseFloat", "isNaN", "isFinite", "eval",
  "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent",
  "structuredClone", "queueMicrotask",
  // Browser / DOM
  "window", "document", "console", "navigator", "location", "history",
  "screen", "frames", "self", "top", "parent", "origin",
  "localStorage", "sessionStorage", "indexedDB", "caches", "crypto",
  "fetch", "Headers", "Request", "Response", "FormData", "WebSocket",
  "URL", "URLSearchParams", "Blob", "File", "FileReader", "FileList",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
  "alert", "confirm", "prompt", "open", "close", "scrollTo", "scrollBy",
  "getComputedStyle", "matchMedia", "getSelection",
  "IntersectionObserver", "ResizeObserver", "MutationObserver",
  "PerformanceObserver", "AbortController", "AbortSignal",
  "Event", "CustomEvent", "EventTarget", "MessageChannel", "MessagePort",
  "Image", "Audio", "Option", "DOMParser", "XMLSerializer", "XMLHttpRequest",
  "performance", "atob", "btoa", "reportError", "Notification",
  "Element", "HTMLElement", "Node", "Text", "Document", "Window",
  "DocumentFragment", "Range", "Selection", "FontFace",
  "DataTransfer", "DataTransferItem", "DataTransferItemList", "ClipboardItem",
  "DragEvent", "ClipboardEvent", "KeyboardEvent", "MouseEvent", "PointerEvent",
  "TouchEvent", "FocusEvent", "WheelEvent", "InputEvent", "SubmitEvent",
  "UIEvent", "AnimationEvent", "TransitionEvent", "ErrorEvent", "MessageEvent",
  "ProgressEvent", "CloseEvent", "PopStateEvent", "HashChangeEvent",
  // Node-ish (DS files occasionally touch these)
  "process", "Buffer", "global", "module", "exports", "require",
  "__dirname", "__filename", "setImmediate", "clearImmediate",
  "NodeJS", "TextEncoder", "TextDecoder",
]);

/** True if the identifier occupies the *name* slot of a member/property/binding
 * construct — i.e. it is not a free value reference but a label or accessor. */
function isNameSlot(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isQualifiedName(p) && p.right === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isPropertySignature(p) && p.name === id) ||
    (ts.isPropertyDeclaration(p) && p.name === id) ||
    (ts.isTypeParameterDeclaration(p) && p.name === id) ||
    (ts.isMethodDeclaration(p) && p.name === id) ||
    (ts.isMethodSignature(p) && p.name === id) ||
    (ts.isGetAccessorDeclaration(p) && p.name === id) ||
    (ts.isSetAccessorDeclaration(p) && p.name === id) ||
    (ts.isEnumMember(p) && p.name === id) ||
    (ts.isJsxAttribute(p) && p.name === id) ||
    (ts.isLabeledStatement(p) && p.label === id) ||
    (ts.isBreakStatement(p) && p.label === id) ||
    (ts.isContinueStatement(p) && p.label === id) ||
    // Declaration name occurrences are bindings, not references.
    (ts.isFunctionDeclaration(p) && p.name === id) ||
    (ts.isFunctionExpression(p) && p.name === id) ||
    (ts.isClassDeclaration(p) && p.name === id) ||
    (ts.isClassExpression(p) && p.name === id) ||
    (ts.isEnumDeclaration(p) && p.name === id) ||
    (ts.isModuleDeclaration(p) && p.name === id) ||
    (ts.isParameter(p) && p.name === id) ||
    (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) ||
    (ts.isVariableDeclaration(p) && p.name === id) ||
    (ts.isImportSpecifier(p) && (p.name === id || p.propertyName === id)) ||
    (ts.isImportClause(p) && p.name === id) ||
    (ts.isNamespaceImport(p) && p.name === id) ||
    (ts.isExportSpecifier(p) && (p.name === id || p.propertyName === id))
  );
}

/** True when `id` is the tag of a JSX element and names a lowercase intrinsic
 * (`div`, `span`) rather than a capitalized component reference. */
function isIntrinsicJsxTag(id: ts.Identifier): boolean {
  const p = id.parent;
  const isTag =
    (ts.isJsxOpeningElement(p) && p.tagName === id) ||
    (ts.isJsxSelfClosingElement(p) && p.tagName === id) ||
    (ts.isJsxClosingElement(p) && p.tagName === id);
  return isTag && /^[a-z]/.test(id.text);
}

/** Collect every value name bound anywhere in the file: imports, top-level and
 * nested declarations, function parameters, destructuring, catch clauses. The
 * set is intentionally scope-flat — a name bound anywhere counts as resolvable
 * everywhere. This can only *miss* a real out-of-scope use; it never invents a
 * false unresolved finding, which is the safe direction for a gate. */
function collectBindings(sf: ts.SourceFile): Set<string> {
  const bound = new Set<string>();
  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      bound.add(name.text);
      return;
    }
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) addBindingName(el.name);
    }
  };

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const clause = n.importClause;
      if (clause) {
        if (clause.name) bound.add(clause.name.text);
        const nb = clause.namedBindings;
        if (nb) {
          if (ts.isNamespaceImport(nb)) bound.add(nb.name.text);
          else for (const el of nb.elements) bound.add(el.name.text);
        }
      }
    } else if (ts.isImportEqualsDeclaration(n)) {
      bound.add(n.name.text);
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      bound.add(n.name.text);
    } else if (ts.isFunctionExpression(n) && n.name) {
      bound.add(n.name.text);
    } else if (ts.isClassDeclaration(n) && n.name) {
      bound.add(n.name.text);
    } else if (ts.isClassExpression(n) && n.name) {
      bound.add(n.name.text);
    } else if (ts.isEnumDeclaration(n)) {
      bound.add(n.name.text);
    } else if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) {
      bound.add(n.name.text);
    } else if (ts.isVariableDeclaration(n)) {
      addBindingName(n.name);
    } else if (ts.isParameter(n)) {
      addBindingName(n.name);
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      addBindingName(n.variableDeclaration.name);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bound;
}

/** Collect free value-position identifier references, skipping type positions,
 * import/export declarations, member-name slots, and intrinsic JSX tags. */
function collectValueRefs(sf: ts.SourceFile): Set<string> {
  const refs = new Set<string>();
  const visit = (n: ts.Node): void => {
    // Type positions never reference runtime values — skip the whole subtree.
    if (ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) {
      return;
    }
    // Import/export bindings are not value references the file must resolve.
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isExportDeclaration(n)) {
      return;
    }
    if (ts.isIdentifier(n)) {
      if (!isNameSlot(n) && !isIntrinsicJsxTag(n)) refs.add(n.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return refs;
}

/** Names declared by 2+ top-level function declarations that each carry a body. */
function collectDuplicateFns(sf: ts.SourceFile): string[] {
  const bodied = new Map<string, number>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      bodied.set(stmt.name.text, (bodied.get(stmt.name.text) ?? 0) + 1);
    }
  }
  return [...bodied.entries()].filter(([, c]) => c >= 2).map(([name]) => name);
}

/**
 * Analyze a single TS/TSX source for compile-integrity defects a convention
 * scanner cannot see: identifiers it references but never binds, and top-level
 * functions it declares twice. Pure and self-contained — no filesystem, no
 * type program, no cross-file resolution — so it stays scoped to the file and
 * never conflates a consumer's own unrelated errors into the result.
 */
export function analyzeResolution(source: string, fileName = "file.tsx"): ResolutionResult {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bound = collectBindings(sf);
  const refs = collectValueRefs(sf);
  const unresolved = [...refs].filter(name => !bound.has(name) && !GLOBALS.has(name)).sort();
  const duplicateFns = collectDuplicateFns(sf).sort();
  return { unresolved, duplicateFns };
}
