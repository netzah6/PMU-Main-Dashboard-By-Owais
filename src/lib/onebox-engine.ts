/* The engine version every funnel page loads. Bump it HERE (and var ENGINE_V
   inside public/onebox.js) whenever the engine changes: the Freeze button
   saves the file under this number and checks the two agree. */
export const ONEBOX_ENGINE_V = 130;

export const liveEngineSrc = `/onebox.js?v=${ONEBOX_ENGINE_V}`;

/* A frozen funnel loads its saved copy (src/app/onebox-frozen). */
export const frozenEngineSrc = (version: number) => `/onebox-frozen/v${version}.js`;
