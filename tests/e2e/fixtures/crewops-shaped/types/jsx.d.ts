declare namespace JSX {
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
  interface Element {}
  interface ElementClass {}
  interface ElementAttributesProperty { props: Record<string, unknown>; }
  interface ElementChildrenAttribute { children: Record<string, unknown>; }
}

declare namespace React {
  type ReactNode = unknown;
  type ComponentType<P = unknown> = (props: P) => unknown;
  function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
}

declare module "react" {
  export = React;
}

declare module "react/jsx-runtime" {
  export const jsx: unknown;
  export const jsxs: unknown;
  export const Fragment: unknown;
}
