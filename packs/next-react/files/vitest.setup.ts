import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Auto-unmount React trees + clear the DOM between tests so leaked state
// from one render() can't bleed into the next assertion.
afterEach(() => {
  cleanup();
});
