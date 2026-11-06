import {fetchSkipMarkers} from '../../dist/backend/segments.js';
const segments=await fetchSkipMarkers({tmdbId:'1399',season:1,episode:1,duration:3720});
console.log('::notice title=LiveMarkers::'+JSON.stringify({intro:segments.intro||null,outro:segments.outro||null}));
if (!segments.intro || !segments.outro) throw Error('Live timestamp lookup did not return known markers');
