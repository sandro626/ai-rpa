export const COMPANION_SETUP_URL = "https://aivane.net/browser-bridge/setup/";

const GUIDANCE = {
  NATIVE_HOST_UNAVAILABLE: {
    primary: "setup",
    setupLabel: "getDesktopApp",
    retry: true,
    eyebrow: "companionNeeded",
    title: "companionMissingTitle",
    description: "companionMissingDescription"
  },
  NATIVE_HOST_START_FAILED: {
    primary: "retry",
    setupLabel: "setupInstructions",
    retry: true,
    eyebrow: "companionOffline",
    title: "companionStartFailedTitle",
    description: "companionStartFailedDescription"
  },
  RECORDER_START_TIMEOUT: {
    primary: "retry",
    setupLabel: "setupInstructions",
    retry: true,
    eyebrow: "companionOffline",
    title: "companionTimeoutTitle",
    description: "companionTimeoutDescription"
  },
  NATIVE_MESSAGING_UNAVAILABLE: {
    primary: "none",
    setupLabel: "setupInstructions",
    retry: false,
    eyebrow: "companionUnsupported",
    title: "companionUnsupportedTitle",
    description: "companionUnsupportedDescription"
  }
};

/**
 * Maps a Recorder command failure onto the companion-app guidance the popup
 * should show. Returns null for failures that are not about the desktop
 * companion; those keep the raw message from the runtime.
 */
export function companionGuidance(code) {
  if (typeof code !== "string") {
    return null;
  }
  return GUIDANCE[code] || null;
}

/**
 * Status polling and broadcast state replace the popup's state wholesale. A
 * companion failure has to survive that, or the guidance would flash away
 * before the user can read it. It clears when the companion connects; a new
 * attempt clears it explicitly.
 */
export function retainCompanionFailure(previous, next) {
  const state = next || {};
  if (state.connected === true || state.errorCode || !previous?.errorCode) {
    return state;
  }
  if (!companionGuidance(previous.errorCode)) {
    return state;
  }
  return {
    ...state,
    error: previous.error,
    errorCode: previous.errorCode
  };
}
