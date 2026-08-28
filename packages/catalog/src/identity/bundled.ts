import { getBundledModels, getBundledProviders } from "../models";
import type { Api, Model } from "../types";
import { buildModelReferenceIndex, type ModelReferenceIndex } from "./reference";

let bundledModels: readonly Model<Api>[] | undefined;

function getBundledModelList(): readonly Model<Api>[] {
	bundledModels ??= getBundledProviders().flatMap(
		provider => getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[],
	);
	return bundledModels;
}

let referenceIndex: ModelReferenceIndex | undefined;

export function getBundledModelReferenceIndex(): ModelReferenceIndex {
	referenceIndex ??= buildModelReferenceIndex(getBundledModelList());
	return referenceIndex;
}
