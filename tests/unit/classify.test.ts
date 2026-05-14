import { describe, it, expect } from "vitest";
import { classify, ClassifyError } from "../../src/lib/classify";

describe("classify", () => {
  it("flags atom imports → composite", () => {
    expect(classify(`import { Button } from "@/design-system/atoms/button";`)).toBe("composite");
  });
  it("flags no design-system imports → atom", () => {
    expect(classify(`import { useState } from "react";`)).toBe("atom");
  });
  it("flags composite imports → tier violation", () => {
    expect(() => classify(`import { Card } from "@/design-system/composites/card";`)).toThrow(ClassifyError);
  });
});
