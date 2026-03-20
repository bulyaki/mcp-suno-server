// types.ts
/**
 * Validates arguments for the generate_music tool
 * @param {any} args - The arguments to validate
 * @returns {boolean} - Whether the arguments are valid
 */
export function isValidSunoMusicRequestArgs(args) {
    if (!args || typeof args !== 'object')
        return false;
    // Custom mode: prompt, tags, title are required
    if (!args.gpt_description_prompt) {
        if (typeof args.prompt !== 'string' || args.prompt.trim() === '')
            return false;
        if (typeof args.tags !== 'string' || args.tags.trim() === '')
            return false;
        if (typeof args.title !== 'string' || args.title.trim() === '')
            return false;
    }
    else { // Inspiration mode: gpt_description_prompt is required
        if (typeof args.gpt_description_prompt !== 'string' || args.gpt_description_prompt.trim() === '')
            return false;
        // In inspiration mode, prompt, tags, title might be optional or not used by the API directly
    }
    if (args.mv !== undefined && !["chirp-v3-0", "chirp-v3-5", "chirp-v4"].includes(args.mv))
        return false;
    if (args.make_instrumental !== undefined && typeof args.make_instrumental !== 'boolean')
        return false;
    // Validate continuation parameters if present
    const hasTaskId = args.task_id !== undefined && typeof args.task_id === 'string' && args.task_id.trim() !== '';
    const hasContinueAt = args.continue_at !== undefined && typeof args.continue_at === 'number' && args.continue_at >= 0;
    const hasContinueClipId = args.continue_clip_id !== undefined && typeof args.continue_clip_id === 'string' && args.continue_clip_id.trim() !== '';
    if (hasTaskId || hasContinueAt || hasContinueClipId) {
        // If any continuation param is present, all three must be present
        if (!(hasTaskId && hasContinueAt && hasContinueClipId)) {
            return false;
        }
    }
    return true;
}
