import type { AdapterOutput, AdapterOutputs, BuildCompleteContext } from "../../src/types.js";
export declare function mockAppPage(overrides?: Partial<AdapterOutput["APP_PAGE"]>): AdapterOutput["APP_PAGE"];
export declare function mockAppRoute(overrides?: Partial<AdapterOutput["APP_ROUTE"]>): AdapterOutput["APP_ROUTE"];
export declare function mockStaticFile(overrides?: Partial<AdapterOutput["STATIC_FILE"]>): AdapterOutput["STATIC_FILE"];
export declare function mockPrerender(overrides?: Partial<AdapterOutput["PRERENDER"]>): AdapterOutput["PRERENDER"];
export declare function mockOutputs(overrides?: Partial<AdapterOutputs>): AdapterOutputs;
export declare function mockRouting(overrides?: Partial<BuildCompleteContext["routing"]>): BuildCompleteContext["routing"];
//# sourceMappingURL=mock-outputs.d.ts.map