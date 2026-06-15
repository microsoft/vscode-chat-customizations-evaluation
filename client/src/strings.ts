export const ACTION_SHOW_PROBLEMS = 'Show Problems';
export const ACTION_FIX_DIAGNOSTICS = 'Implement suggestions';
export const ACTION_COPY_SUGGESTION = 'Copy suggestion to clipboard';
export const ACTION_INSERT_SUGGESTION_COMMENT = 'Insert suggestion as comment';
export const ACTION_ANALYZE_AGAIN = 'Analyze Again';
export const ACTION_INSTALL_WAZA_BINARY = 'Install Waza Binary';
export const ACTION_OPEN_WAZA_USER_GUIDE = 'Open Waza User Guide';
export const MESSAGE_NO_SUGGESTION_TO_COPY = 'No suggestion is available to copy for this diagnostic.';
export const MESSAGE_SUGGESTION_COPIED = 'Suggestion copied to clipboard.';

export const TELEMETRY_ENDPOINT_ENV = 'CHAT_CUSTOMIZATIONS_EVALUATIONS_TELEMETRY_ENDPOINT';
export const TELEMETRY_AUTH_TOKEN_ENV = 'CHAT_CUSTOMIZATIONS_EVALUATIONS_TELEMETRY_AUTH_TOKEN';

export const NON_FIXABLE_DIAGNOSTIC_CODES = ['llm-error', 'llm-parse-error'] as const;
