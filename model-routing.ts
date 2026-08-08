export function needsResponsesAPI(model: string): boolean {
    return /^(?:gpt-5\.(?:[2-9]|\d{2,})(?:-codex)?|o\d+|goldeneye)/i.test(model);
}

export function resolveUpstreamModelId(model: string): string {
    return model.replace(
        /^(claude-(?:opus|sonnet|haiku)-\d+)-(\d{1,2})$/i,
        '$1.$2',
    );
}

export function resolveAdvertisedModelId(model: string): string {
    return model.replace(
        /^(claude-(?:opus|sonnet|haiku)-\d+)\.(\d{1,2})$/i,
        '$1-$2',
    );
}

// Cursor decides a model's context window from its own catalog, ignoring the
// limits reported by /v1/models. Serving a model under an alias that doesn't
// match a catalog entry lets Cursor fall back to its large default instead of
// the smaller advertised window.
export function resolveModelAlias(model: string, aliases: Record<string, string>): string {
    return aliases[model] ?? model;
}

// Builds the extra /v1/models entries that expose each alias, copying the
// capabilities of the model it points at so clients see identical metadata.
export function buildAliasModelEntries(
    models: any[],
    aliases: Record<string, string>,
): any[] {
    return Object.entries(aliases).flatMap(([alias, target]) => {
        const source = models.find((model: any) =>
            model?.id === target
            || (typeof model?.id === 'string'
                && resolveUpstreamModelId(model.id) === resolveUpstreamModelId(target))
        );
        if (!source) return [];
        return [{ ...source, id: alias, display_name: alias }];
    });
}
