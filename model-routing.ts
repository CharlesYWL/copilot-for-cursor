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
