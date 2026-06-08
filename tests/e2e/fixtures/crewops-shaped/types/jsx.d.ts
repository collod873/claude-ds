declare namespace JSX {
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
  interface Element {}
  interface ElementClass {}
  interface ElementAttributesProperty { props: Record<string, unknown>; }
  interface ElementChildrenAttribute { children: Record<string, unknown>; }
}

declare module "react" {
  export type ReactNode = unknown;
  const React: unknown;
  export default React;
}

declare module "react/jsx-runtime" {
  export const jsx: unknown;
  export const jsxs: unknown;
  export const Fragment: unknown;
}
