export type EqParameter = "Gain" | "Freq" | "Q";

export type EqBand = {
  index: number;
  name: string;
  freq: number;
  gain: number;
  q: number;
  enabled?: boolean;
};

export type EqPreset = {
  id: string;
  name: string;
  bands: EqBand[];
  bassBoost: number;
  preamp?: number;
};

export type PipeWireNode = {
  id: number;
  name: string;
  description: string;
  mediaClass?: string;
  params: Record<string, unknown>;
};

export type PipeWireNodeSummary = Pick<PipeWireNode, "id" | "name" | "description">;
