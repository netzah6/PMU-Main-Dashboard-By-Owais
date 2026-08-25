// Create/refresh the B2B one-box funnel row (slug pmu-bookings)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const row = {
  slug: 'pmu-bookings',
  location_id: 'SfpNMJ5YU9lBkxss47lK',
  client_name: 'PMU Bookings On Demand (B2B)',
  status: 'live',
  config: {},
  cv_synced_at: new Date().toISOString(), // never actually synced; template guard skips it
  extras: {
    template: 'b2b',
    b2b: {
      calendarId: 'sM5ENt37b5MGwKDOSOrl',   // "Nicolas (CEO) | Discovery Call", 15 min
      tag: 'b2b-onebox-survey',
      metaPixelId: '1620243578329043,972935447018283', // both pixels on the original funnel
      fieldMap: {
        area:      'uh5NgGMi7u4iFa6OQino',  // What area do you serve?
        spots:     'COuOabENO1LSVvldJWcd',  // How many spots do you need?
        weekly:    'cCGegHN07y3kP5QB4CPN',  // How many brows bookings can you handle every week?
        start:     '4voebbvFK1UiVZkawa7Q',  // If accepted, how soon...
        exp:       'fAuVZ3uyhvAUOX5Rgev9',  // How long have you been a PMU artist?
        rev:       'XhuvfuvuO77NjHrkPPhb',  // Current annual revenue
        want:      '7YvT9x7VNLB1zkBykzj6',  // Desired annual revenue
        edge:      'w4peA6usQZoTFZVl7TSj',  // What sets YOU apart
        utm_ad:    'HUNv21W1zPbr6VaiERWc',  // UTM Ad
        utm_adset: 'SLuxabPh3ySzo6I3mVPl',  // UTM Adset
      },
    },
  },
};
const { error } = await svc.from('onebox_clients').upsert(row, { onConflict: 'slug' });
console.log(error ? 'ERROR: '+error.message : 'row upserted: pmu-bookings');
const { data } = await svc.from('onebox_clients').select('slug,status,location_id,extras').eq('slug','pmu-bookings').single();
console.log(JSON.stringify(data, null, 1).slice(0, 500));
