import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount between tests so queries can't match a previous test's leftover DOM —
// the classic source of a suite that passes in isolation and lies in aggregate.
afterEach(() => cleanup());
