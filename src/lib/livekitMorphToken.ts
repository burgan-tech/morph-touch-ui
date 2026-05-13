type MorphLiveKitGlobal = typeof globalThis & { __morphTouchLiveKitMorphToken?: string };

/** Patched livekit-client reads this for Morph gateway auth (access_token + room_token). */
export function setLiveKitMorphVideoToken(token: string | null): void {
  const g = globalThis as MorphLiveKitGlobal;
  g.__morphTouchLiveKitMorphToken = token && token.length > 0 ? token : undefined;
}
