export type ModelReference =
  | string
  | Readonly<{
      provider: string;
      model: string;
    }>;

/** Supplies the models that are currently usable by the runtime. */
export interface ModelCatalog {
  isAvailable(model: ModelReference): boolean;
}
