import ts from "typescript";

/**
 * Result of a single-file symbol-resolution analysis.
 *
 * `unresolved` — identifiers a file references (both value-position AND
 * type-position) that are bound nowhere in the file (no import, no local
 * declaration, no parameter) and are not a known runtime global or built-in
 * type. Covers `TS2304 Cannot find name` for both value and type references.
 *
 * `typeOnlySymbols` — subset of `unresolved` whose names appear ONLY in
 * type position (type annotations, type alias bodies, interface members,
 * `as`-cast targets, generic arguments) and NOT in value position. The
 * repair path uses this to emit `import type { X }` rather than
 * `import { X }`, which is required when the symbol is a pure type export
 * (e.g. `LucideIcon` from lucide-react) or when `isolatedModules` is on.
 *
 * `duplicateFns` — names declared by two or more *top-level* function
 * declarations that each carry a body (`TS2393 Duplicate function
 * implementation`). Overload signatures (multiple declarations, one body) are
 * intentionally not flagged.
 */
export interface ResolutionResult {
  unresolved: string[];
  /** Unresolved names that appear ONLY in type position — need `import type`. */
  typeOnlySymbols: Set<string>;
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

/**
 * Built-in type-position names that are always resolvable without an import.
 * Covers TypeScript primitive keywords, utility types, DOM type interfaces,
 * JSX globals, and React type helpers that ship in `@types/react`. A missing
 * entry produces a false `unresolved` finding, so the list errs toward
 * inclusion (same philosophy as GLOBALS above).
 *
 * Note: TypeScript keywords (`string`, `number`, …) are already parsed as
 * keyword type nodes rather than TypeReference nodes, so they never reach the
 * type-ref collector. This list handles names that appear as TypeReferences
 * in the AST — i.e. capitalized utility types and ambient DOM/React types.
 */
const TYPE_GLOBALS = new Set<string>([
  // TypeScript utility types
  "Partial", "Required", "Readonly", "Record", "Pick", "Omit",
  "Exclude", "Extract", "NonNullable", "ReturnType", "InstanceType",
  "Parameters", "ConstructorParameters", "ThisParameterType",
  "OmitThisParameter", "ThisType", "Awaited", "Uppercase", "Lowercase",
  "Capitalize", "Uncapitalize",
  // Promise / async helpers
  "Promise", "PromiseLike", "PromiseConstructor",
  // Iterables
  "Iterable", "IterableIterator", "Iterator", "IteratorResult",
  "Generator", "AsyncGenerator", "AsyncIterable", "AsyncIterableIterator",
  // TypeScript built-in type constructors and object models
  "Array", "ReadonlyArray", "ReadonlyMap", "ReadonlySet",
  "Map", "Set", "WeakMap", "WeakSet", "WeakRef",
  "Object", "Function", "Symbol", "BigInt",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "EvalError", "URIError", "AggregateError",
  "RegExp", "Date", "JSON", "Math", "Intl",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array", "ArrayBuffer", "SharedArrayBuffer",
  "DataView", "Atomics",
  // Template literal helpers
  "TemplateStringsArray",
  // DOM types
  "Element", "HTMLElement", "HTMLDivElement", "HTMLSpanElement",
  "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
  "HTMLButtonElement", "HTMLAnchorElement", "HTMLImageElement",
  "HTMLFormElement", "HTMLLabelElement", "HTMLCanvasElement",
  "HTMLVideoElement", "HTMLAudioElement", "HTMLTableElement",
  "HTMLDialogElement", "HTMLDetailsElement", "HTMLSlotElement",
  "HTMLTemplateElement", "HTMLScriptElement", "HTMLStyleElement",
  "SVGElement", "SVGSVGElement", "SVGPathElement",
  "Node", "Text", "Comment", "DocumentFragment", "Document", "Window",
  "EventTarget", "Event", "CustomEvent",
  "MouseEvent", "KeyboardEvent", "FocusEvent", "InputEvent", "SubmitEvent",
  "PointerEvent", "TouchEvent", "WheelEvent", "DragEvent", "ClipboardEvent",
  "AnimationEvent", "TransitionEvent", "ErrorEvent", "MessageEvent",
  "ProgressEvent", "UIEvent",
  "MutationObserver", "IntersectionObserver", "ResizeObserver",
  "PerformanceObserver", "AbortController", "AbortSignal",
  "Request", "Response", "Headers", "FormData", "Blob", "File", "FileList",
  "FileReader", "URL", "URLSearchParams", "WebSocket",
  "ReadableStream", "WritableStream", "TransformStream",
  "Notification", "FontFace", "Range", "Selection",
  "DataTransfer", "DataTransferItem", "DataTransferItemList", "ClipboardItem",
  "MediaQueryList", "MutationRecord", "IntersectionObserverEntry",
  "ResizeObserverEntry", "PerformanceEntry",
  "Storage", "IDBDatabase", "IDBTransaction", "IDBRequest",
  "CanvasRenderingContext2D", "ImageData",
  "Worker", "ServiceWorker", "BroadcastChannel", "MessagePort", "MessageChannel",
  "CSSStyleDeclaration",
  // JSX / React ambient types
  "JSX",
  "React",
  // Node.js types
  "NodeJS", "Buffer", "NodeRequire",
  "process",
  // Common lib types
  "PropertyKey", "PropertyDescriptor",
  "TypedPropertyDescriptor",
  "ClassDecorator", "PropertyDecorator", "MethodDecorator", "ParameterDecorator",
  "ProxyHandler", "ProxyConstructor",
  "ArrayLike", "ArrayConstructor",
  "FlatArray",
  // Strict mode helpers (most parse as keyword type nodes, but guard here too)
  "never", "unknown", "any", "void",
  // `as const` parses as AsExpression → TypeReference(Identifier("const")).
  // `const` is a reserved word and can never be an imported name.
  "const",
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
    } else if (ts.isInterfaceDeclaration(n)) {
      // Interface names are type-space bindings; capture them so a file that
      // declares `interface Foo` and references `Foo` in type position is clean.
      bound.add(n.name.text);
    } else if (ts.isTypeAliasDeclaration(n)) {
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

/**
 * Collect free type-position identifier references — names used as types in
 * annotations, generic arguments, `as`-casts, `interface` member types, and
 * `type`-alias bodies. These are what `tsc --noEmit` checks as `TS2304 Cannot
 * find name` when the referenced type is not imported or locally declared.
 *
 * Strategy: walk the whole file, visiting type nodes wherever they appear
 * (param annotations, return-type annotations, variable type annotations,
 * property types, as-cast targets, type alias bodies, interface/class
 * heritage, etc.). Inside type subtrees, collect every TypeReference's root
 * identifier, skipping names that are in-scope type parameters of the
 * enclosing generic context. Import and export declarations are skipped
 * entirely — they are resolved by `INTEGRITY-UNRESOLVABLE-IMPORT`.
 *
 * Type parameters are tracked via a `typeParams` set that is extended when
 * entering a generic context (function, class, interface, type alias) and
 * restored when leaving it, so that `T` in `function f<T>(x: T): T` is never
 * reported as unresolved.
 */
function collectTypeRefs(sf: ts.SourceFile): Set<string> {
  const refs = new Set<string>();

  /** Visit a type node, skipping any TypeReference whose root name is in
   * the caller's in-scope type-parameter set. */
  const visitTypeNode = (n: ts.Node, typeParams: ReadonlySet<string>): void => {
    if (ts.isTypeReferenceNode(n)) {
      const name = n.typeName;
      // For a qualified name like `React.FC`, only `React` is a free binding.
      const root = ts.isQualifiedName(name) ? name.left : name;
      if (ts.isIdentifier(root) && !typeParams.has(root.text)) {
        refs.add(root.text);
      }
      // Recurse into type arguments with the same type-param scope.
      if (n.typeArguments) {
        for (const arg of n.typeArguments) visitTypeNode(arg, typeParams);
      }
      return;
    }
    if (ts.isTypeParameterDeclaration(n)) {
      // The name is a binding site — skip it; only visit constraint/default.
      if (n.constraint) visitTypeNode(n.constraint, typeParams);
      if (n.default) visitTypeNode(n.default, typeParams);
      return;
    }
    // ExpressionWithTypeArguments appears in heritage clauses; the expression
    // part is a value-position identifier (already handled by collectValueRefs)
    // but the type arguments are type-position.
    if (ts.isExpressionWithTypeArguments(n)) {
      // The expression itself (e.g. `BaseNavItem`) is in value position in
      // heritage clauses for classes (implements/extends in class) but in
      // type position in interface extends. Handle both: check the expression
      // identifier as a type-ref since interface heritage is purely type space.
      const expr = n.expression;
      if (ts.isIdentifier(expr) && !typeParams.has(expr.text)) {
        refs.add(expr.text);
      } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        // Qualified: only the root namespace identifier matters.
        if (!typeParams.has(expr.expression.text)) {
          refs.add(expr.expression.text);
        }
      }
      if (n.typeArguments) {
        for (const arg of n.typeArguments) visitTypeNode(arg, typeParams);
      }
      return;
    }
    // TypeElement nodes (PropertySignature, MethodSignature, IndexSignatureDeclaration,
    // CallSignatureDeclaration, ConstructSignatureDeclaration) appear as direct children
    // of TypeLiteralNode — they are NOT TypeNode themselves but their type-annotation
    // children are. Recurse into their type positions so that `type T = { icon: LucideIcon }`
    // collects `LucideIcon` the same way an inline `{ icon: LucideIcon }` function param does.
    if (ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) {
      if (n.type) visitTypeNode(n.type, typeParams);
      return;
    }
    if (ts.isMethodSignature(n)) {
      const inner = new Set([...typeParams, ...gatherTypeParamNames(n.typeParameters)]);
      for (const tp of n.typeParameters ?? []) visitTypeNode(tp, typeParams);
      for (const p of n.parameters) {
        if (p.type) visitTypeNode(p.type, inner);
      }
      if (n.type) visitTypeNode(n.type, inner);
      return;
    }
    if (ts.isIndexSignatureDeclaration(n)) {
      for (const p of n.parameters) {
        if (p.type) visitTypeNode(p.type, typeParams);
      }
      visitTypeNode(n.type, typeParams);
      return;
    }
    if (ts.isCallSignatureDeclaration(n) || ts.isConstructSignatureDeclaration(n)) {
      const inner = new Set([...typeParams, ...gatherTypeParamNames(n.typeParameters)]);
      for (const tp of n.typeParameters ?? []) visitTypeNode(tp, typeParams);
      for (const p of n.parameters) {
        if (p.type) visitTypeNode(p.type, inner);
      }
      if (n.type) visitTypeNode(n.type, inner);
      return;
    }
    // Parameter nodes appear as children of function-like type nodes
    // (e.g. FunctionTypeNode `(icon: LucideIcon) => void`).
    if (ts.isParameter(n)) {
      if (n.type) visitTypeNode(n.type, typeParams);
      return;
    }
    // All other type nodes: recurse.
    if (ts.isTypeNode(n)) {
      ts.forEachChild(n, c => visitTypeNode(c, typeParams));
      return;
    }
  };

  /** Build the set of type-parameter names declared at a generic site. */
  const gatherTypeParamNames = (
    tps: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  ): string[] => (tps ?? []).map(tp => tp.name.text);

  /**
   * Walk the whole source file visiting all type-annotation contexts.
   * `typeParams` carries the in-scope type-parameter names at each point.
   */
  const visitAll = (n: ts.Node, typeParams: ReadonlySet<string>): void => {
    // Import/export declarations: skip entirely.
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isExportDeclaration(n)) {
      return;
    }

    // Type-alias: extend scope with its own type params.
    if (ts.isTypeAliasDeclaration(n)) {
      const inner = new Set([...typeParams, ...gatherTypeParamNames(n.typeParameters)]);
      // Visit type-param constraints/defaults under the outer scope (they can't
      // reference the alias's own params in standard TS).
      for (const tp of n.typeParameters ?? []) visitTypeNode(tp, typeParams);
      visitTypeNode(n.type, inner);
      return;
    }

    // Interface declaration: extend scope, visit heritage + members.
    if (ts.isInterfaceDeclaration(n)) {
      const inner = new Set([...typeParams, ...gatherTypeParamNames(n.typeParameters)]);
      for (const tp of n.typeParameters ?? []) visitTypeNode(tp, typeParams);
      for (const h of n.heritageClauses ?? []) {
        for (const t of h.types) visitTypeNode(t, inner);
      }
      ts.forEachChild(n, c => visitAll(c, inner));
      return;
    }

    // Class declaration/expression: extend scope, visit heritage + members.
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      const inner = new Set([...typeParams, ...gatherTypeParamNames(n.typeParameters)]);
      for (const tp of n.typeParameters ?? []) visitTypeNode(tp, typeParams);
      for (const h of n.heritageClauses ?? []) {
        // Class heritage: `extends` is value position (skip identifier), but
        // type arguments are type-position; `implements` is type-position.
        for (const t of h.types) {
          if (h.token === ts.SyntaxKind.ExtendsKeyword) {
            // Only type arguments are type-position for class extends.
            if (t.typeArguments) {
              for (const arg of t.typeArguments) visitTypeNode(arg, inner);
            }
          } else {
            // `implements` clause: the whole ExpressionWithTypeArguments.
            visitTypeNode(t, inner);
          }
        }
      }
      ts.forEachChild(n, c => visitAll(c, inner));
      return;
    }

    // Function-like declarations: extend scope with function's type params.
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n)
    ) {
      const inner = new Set([...typeParams, ...gatherTypeParamNames(n.typeParameters)]);
      for (const tp of n.typeParameters ?? []) visitTypeNode(tp, typeParams);
      for (const p of n.parameters) {
        if (p.type) visitTypeNode(p.type, inner);
      }
      if (n.type) visitTypeNode(n.type, inner);
      // Recurse into body with the extended scope.
      ts.forEachChild(n, c => visitAll(c, inner));
      return;
    }

    // Variable declaration: explicit type annotation.
    if (ts.isVariableDeclaration(n)) {
      if (n.type) visitTypeNode(n.type, typeParams);
      ts.forEachChild(n, c => visitAll(c, typeParams));
      return;
    }

    // Property signature / declaration: type annotation.
    if (ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) {
      if (n.type) visitTypeNode(n.type, typeParams);
      ts.forEachChild(n, c => visitAll(c, typeParams));
      return;
    }

    // Index signature (in interface/class): type annotations.
    if (ts.isIndexSignatureDeclaration(n)) {
      for (const p of n.parameters) {
        if (p.type) visitTypeNode(p.type, typeParams);
      }
      visitTypeNode(n.type, typeParams);
      return;
    }

    // Call/construct signature in an interface.
    if (ts.isCallSignatureDeclaration(n) || ts.isConstructSignatureDeclaration(n)) {
      const inner = new Set([...typeParams, ...gatherTypeParamNames(n.typeParameters)]);
      for (const tp of n.typeParameters ?? []) visitTypeNode(tp, typeParams);
      for (const p of n.parameters) {
        if (p.type) visitTypeNode(p.type, inner);
      }
      if (n.type) visitTypeNode(n.type, inner);
      return;
    }

    // Method signature (in interface).
    if (ts.isMethodSignature(n)) {
      const inner = new Set([...typeParams, ...gatherTypeParamNames(n.typeParameters)]);
      for (const tp of n.typeParameters ?? []) visitTypeNode(tp, typeParams);
      for (const p of n.parameters) {
        if (p.type) visitTypeNode(p.type, inner);
      }
      if (n.type) visitTypeNode(n.type, inner);
      return;
    }

    // As-expression (`x as Foo`) and type assertion (`<Foo>x`): cast target.
    if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
      visitTypeNode(n.type, typeParams);
      ts.forEachChild(n, c => visitAll(c, typeParams));
      return;
    }

    // Satisfies expression (`x satisfies Foo`): the type operand.
    if (ts.isSatisfiesExpression(n)) {
      visitTypeNode(n.type, typeParams);
      ts.forEachChild(n, c => visitAll(c, typeParams));
      return;
    }

    // Default: continue descending.
    ts.forEachChild(n, c => visitAll(c, typeParams));
  };

  ts.forEachChild(sf, c => visitAll(c, new Set()));
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
 * scanner cannot see: identifiers it references but never binds (both in value
 * position and type position), and top-level functions it declares twice. Pure
 * and self-contained — no filesystem, no type program, no cross-file resolution
 * — so it stays scoped to the file and never conflates a consumer's own
 * unrelated errors into the result.
 *
 * Value-position misses: checked against GLOBALS (runtime names never needing
 * an import). Type-position misses: checked against TYPE_GLOBALS (TypeScript
 * built-in utility types, lib.dom types, JSX ambient types). Both sets are
 * also checked against `bound` — locally-declared names (including interface
 * and type-alias names) are always considered resolved.
 */
export function analyzeResolution(source: string, fileName = "file.tsx"): ResolutionResult {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bound = collectBindings(sf);

  const valueRefs = collectValueRefs(sf);
  const unresolvedValues = [...valueRefs].filter(
    name => !bound.has(name) && !GLOBALS.has(name),
  );

  const typeRefs = collectTypeRefs(sf);
  const unresolvedTypes = [...typeRefs].filter(
    name => !bound.has(name) && !TYPE_GLOBALS.has(name) && !GLOBALS.has(name),
  );

  // Merge and de-duplicate: a name may appear in both value and type position
  // in the same file. Report it once.
  const unresolvedSet = new Set([...unresolvedValues, ...unresolvedTypes]);
  const unresolved = [...unresolvedSet].sort();

  // Compute type-only symbols: names that appear ONLY in type position (i.e. in
  // typeRefs but NOT in valueRefs). These need `import type { X }` not `import { X }`.
  const valueRefSet = new Set(unresolvedValues);
  const typeOnlySymbols = new Set(
    [...unresolvedTypes].filter(name => !valueRefSet.has(name)),
  );

  const duplicateFns = collectDuplicateFns(sf).sort();
  return { unresolved, typeOnlySymbols, duplicateFns };
}
