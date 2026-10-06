import type { CreatorCategory } from '@runningapp/contracts';

/**
 * The cast and the story of the seeded world. Everything here is fictional: invented names,
 * `@seed.example` addresses (a reserved, undeliverable domain) and made-up locations.
 */

export type Sport =
  'running' | 'cycling' | 'swimming' | 'strength_training' | 'hiking' | 'triathlon' | 'walking';

interface Plan {
  /** Average activities per week. */
  perWeek: number;
  /** Sport mix with relative weights. */
  sports: ReadonlyArray<readonly [Sport, number]>;
  /** Chance an activity gets a video / photo attached (the "SHOW" step). */
  videoChance: number;
  photoChance: number;
  /** Fitness multiplier on speed (1 = average club athlete). */
  fitness: number;
  visibility: 'PUBLIC' | 'FOLLOWERS';
  routePrivacy: 'FULL' | 'TRIMMED' | 'APPROXIMATE' | 'HIDDEN';
}

export interface Person {
  key: string;
  username: string;
  displayName: string;
  bio: string;
  location: string;
  birthDate: string;
  home: readonly [number, number];
  avatarColor: string;
  primarySport?: Sport;
  sports: ReadonlyArray<{ sport: Sport; relation: 'PARTICIPANT' | 'FOLLOWER' }>;
  isPrivate?: boolean;
  discoverable?: boolean;
  emailVerified?: boolean;
  role?: 'MODERATOR' | 'ADMIN';
  creator?: { category: CreatorCategory; tagline: string; website?: string; verified?: boolean };
  plan?: Plan;
  zone?: { label: string; radiusM: number };
  note: string;
}

export const PEOPLE: readonly Person[] = [
  {
    key: 'maya',
    username: 'maya_runs',
    displayName: 'Maya Okafor',
    bio: 'Marathon chaser. Coffee first, miles second. Portland, OR.',
    location: 'Portland, OR',
    birthDate: '1992-04-18',
    home: [45.5231, -122.6765],
    avatarColor: 'e76f51',
    primarySport: 'running',
    sports: [
      { sport: 'running', relation: 'PARTICIPANT' },
      { sport: 'strength_training', relation: 'PARTICIPANT' },
      { sport: 'cycling', relation: 'FOLLOWER' },
    ],
    plan: {
      perWeek: 5.5,
      sports: [
        ['running', 8],
        ['strength_training', 1.5],
      ],
      videoChance: 0.3,
      photoChance: 0.1,
      fitness: 1.12,
      visibility: 'PUBLIC',
      routePrivacy: 'TRIMMED',
    },
    zone: { label: 'Home', radiusM: 250 },
    note: 'MAIN DEMO ACCOUNT: public runner with a busy feed, a privacy zone and a block; follows only some people so Explore and suggestions have content.',
  },
  {
    key: 'leo',
    username: 'leo_gravel',
    displayName: 'Leo Marchetti',
    bio: 'Gravel, bikepacking and bad puns. Bend, OR.',
    location: 'Bend, OR',
    birthDate: '1988-09-02',
    home: [44.0582, -121.3153],
    avatarColor: '2a9d8f',
    primarySport: 'cycling',
    sports: [
      { sport: 'cycling', relation: 'PARTICIPANT' },
      { sport: 'hiking', relation: 'PARTICIPANT' },
    ],
    creator: {
      category: 'CONTENT_CREATOR',
      tagline: 'Gravel stories from the high desert',
      website: 'https://leo-gravel.example',
      verified: true,
    },
    plan: {
      perWeek: 4,
      sports: [
        ['cycling', 8],
        ['hiking', 1],
      ],
      videoChance: 0.4,
      photoChance: 0.15,
      fitness: 1.05,
      visibility: 'PUBLIC',
      routePrivacy: 'APPROXIMATE',
    },
    note: 'Verified content creator (cycling) with sponsored posts.',
  },
  {
    key: 'sora',
    username: 'sora_swims',
    displayName: 'Sora Tanaka',
    bio: 'Masters swimmer. Lane 3, always.',
    location: 'Seattle, WA',
    birthDate: '1990-01-27',
    home: [47.6062, -122.3321],
    avatarColor: '457b9d',
    primarySport: 'swimming',
    sports: [
      { sport: 'swimming', relation: 'PARTICIPANT' },
      { sport: 'running', relation: 'PARTICIPANT' },
    ],
    plan: {
      perWeek: 4,
      sports: [
        ['swimming', 7],
        ['running', 2],
      ],
      videoChance: 0.2,
      photoChance: 0.05,
      fitness: 1.0,
      visibility: 'PUBLIC',
      routePrivacy: 'TRIMMED',
    },
    note: 'Swimmer: activities without routes or elevation.',
  },
  {
    key: 'dani',
    username: 'coach_dani',
    displayName: 'Dani Reyes',
    bio: 'Run coach. Making easy runs easy since 2012. Training plans below.',
    location: 'Austin, TX',
    birthDate: '1985-11-09',
    home: [30.2672, -97.7431],
    avatarColor: 'f4a261',
    primarySport: 'running',
    sports: [{ sport: 'running', relation: 'PARTICIPANT' }],
    creator: {
      category: 'COACH',
      tagline: 'Coaching runners to run happier',
      website: 'https://dani-coaching.example',
      verified: true,
    },
    plan: {
      perWeek: 3,
      sports: [['running', 1]],
      videoChance: 0.15,
      photoChance: 0.05,
      fitness: 1.1,
      visibility: 'PUBLIC',
      routePrivacy: 'APPROXIMATE',
    },
    note: 'Verified coach: standalone teaching videos plus an affiliate post.',
  },
  {
    key: 'stride',
    username: 'stride_running',
    displayName: 'Stride Running Co.',
    bio: 'Shoes and kit built by runners. Official account.',
    location: 'Eugene, OR',
    birthDate: '1980-01-01',
    home: [44.0521, -123.0868],
    avatarColor: '1d3557',
    sports: [{ sport: 'running', relation: 'PARTICIPANT' }],
    creator: {
      category: 'BRAND',
      tagline: 'Built for the long run',
      website: 'https://stride.example',
      verified: true,
    },
    note: 'Verified brand account; the brand in sponsored posts by creators.',
  },
  {
    key: 'ben',
    username: 'ben_lifts',
    displayName: 'Ben Carter',
    bio: 'Powerlifting + the occasional jog. Denver, CO.',
    location: 'Denver, CO',
    birthDate: '1994-06-30',
    home: [39.7392, -104.9903],
    avatarColor: '6d597a',
    primarySport: 'strength_training',
    sports: [{ sport: 'strength_training', relation: 'PARTICIPANT' }],
    plan: {
      perWeek: 4.5,
      sports: [
        ['strength_training', 9],
        ['running', 1],
      ],
      videoChance: 0.1,
      photoChance: 0.35,
      fitness: 0.9,
      visibility: 'PUBLIC',
      routePrivacy: 'HIDDEN',
    },
    note: 'Strength athlete: photo-heavy, activities without routes.',
  },
  {
    key: 'priya',
    username: 'private_priya',
    displayName: 'Priya Nair',
    bio: 'Private account: approve to see my training.',
    location: 'Boston, MA',
    birthDate: '1991-03-12',
    home: [42.3601, -71.0589],
    avatarColor: 'b56576',
    primarySport: 'running',
    isPrivate: true,
    sports: [{ sport: 'running', relation: 'PARTICIPANT' }],
    plan: {
      perWeek: 4,
      sports: [['running', 1]],
      videoChance: 0.15,
      photoChance: 0.1,
      fitness: 1.0,
      visibility: 'FOLLOWERS',
      routePrivacy: 'HIDDEN',
    },
    note: 'PRIVATE account: only approved followers see anything. Has a pending follower request.',
  },
  {
    key: 'quentin',
    username: 'quiet_quentin',
    displayName: 'Quentin Blake',
    bio: 'Not on the leaderboards. Not on search either.',
    location: 'Madison, WI',
    birthDate: '1987-07-21',
    home: [43.0731, -89.4012],
    avatarColor: '555b6e',
    primarySport: 'running',
    discoverable: false,
    sports: [{ sport: 'running', relation: 'PARTICIPANT' }],
    plan: {
      perWeek: 3,
      sports: [['running', 1]],
      videoChance: 0.05,
      photoChance: 0.05,
      fitness: 0.95,
      visibility: 'PUBLIC',
      routePrivacy: 'TRIMMED',
    },
    note: 'Opted out of discovery: absent from search, suggestions and explore.',
  },
  {
    key: 'tess',
    username: 'teen_tess',
    displayName: 'Tess Morgan',
    bio: 'Cross country team. 5k PR chaser.',
    location: 'Corvallis, OR',
    birthDate: '2011-05-14',
    home: [44.5646, -123.262],
    avatarColor: '8ac926',
    primarySport: 'running',
    isPrivate: true,
    sports: [{ sport: 'running', relation: 'PARTICIPANT' }],
    plan: {
      perWeek: 3,
      sports: [['running', 1]],
      videoChance: 0.1,
      photoChance: 0.05,
      fitness: 0.95,
      visibility: 'FOLLOWERS',
      routePrivacy: 'HIDDEN',
    },
    note: 'MINOR (under 16): private by policy, never PUBLIC, never in search/suggestions/sponsored discovery.',
  },
  {
    key: 'nina',
    username: 'new_nina',
    displayName: 'Nina Alvarez',
    bio: '',
    location: 'Phoenix, AZ',
    birthDate: '1996-12-05',
    home: [33.4484, -112.074],
    avatarColor: 'cccccc',
    sports: [],
    note: 'BRAND-NEW user: follows nobody, no posts. Use for onboarding and cold-start feeds.',
  },
  {
    key: 'bob',
    username: 'blocked_bob',
    displayName: 'Bob Stanton',
    bio: 'Buy my stuff.',
    location: 'Miami, FL',
    birthDate: '1989-08-19',
    home: [25.7617, -80.1918],
    avatarColor: 'bc4749',
    sports: [{ sport: 'running', relation: 'FOLLOWER' }],
    note: 'Spammer: blocked by Maya, one post hidden by moderation, one in the open report queue.',
  },
  {
    key: 'tom',
    username: 'tri_tom',
    displayName: 'Tom Becker',
    bio: 'Swim, bike, run, repeat. Boulder, CO.',
    location: 'Boulder, CO',
    birthDate: '1986-02-14',
    home: [40.015, -105.2705],
    avatarColor: '3a86ff',
    primarySport: 'triathlon',
    sports: [
      { sport: 'triathlon', relation: 'PARTICIPANT' },
      { sport: 'cycling', relation: 'PARTICIPANT' },
      { sport: 'running', relation: 'PARTICIPANT' },
      { sport: 'swimming', relation: 'PARTICIPANT' },
    ],
    plan: {
      perWeek: 6,
      sports: [
        ['cycling', 3],
        ['running', 3],
        ['swimming', 2],
        ['triathlon', 0.2],
      ],
      videoChance: 0.2,
      photoChance: 0.1,
      fitness: 1.08,
      visibility: 'PUBLIC',
      routePrivacy: 'TRIMMED',
    },
    note: 'Multi-sport athlete.',
  },
  {
    key: 'hana',
    username: 'hiker_hana',
    displayName: 'Hana Kobayashi',
    bio: 'Peaks over pavement. Salt Lake City.',
    location: 'Salt Lake City, UT',
    birthDate: '1993-10-03',
    home: [40.7608, -111.891],
    avatarColor: '588157',
    primarySport: 'hiking',
    sports: [
      { sport: 'hiking', relation: 'PARTICIPANT' },
      { sport: 'running', relation: 'PARTICIPANT' },
    ],
    plan: {
      perWeek: 3,
      sports: [
        ['hiking', 4],
        ['running', 1],
      ],
      videoChance: 0.25,
      photoChance: 0.3,
      fitness: 1.0,
      visibility: 'PUBLIC',
      routePrivacy: 'FULL',
    },
    note: 'Hiker with FULL route privacy and lots of photos.',
  },
  {
    key: 'morgan',
    username: 'mod_morgan',
    displayName: 'Morgan Lee',
    bio: 'Community moderator.',
    location: 'Remote',
    birthDate: '1984-05-25',
    home: [37.7749, -122.4194],
    avatarColor: '264653',
    sports: [],
    role: 'MODERATOR',
    note: 'MODERATOR: can use /v1/admin/reports and take moderation actions.',
  },
  {
    key: 'alex',
    username: 'admin_alex',
    displayName: 'Alex Rivera',
    bio: 'Platform admin.',
    location: 'Remote',
    birthDate: '1983-12-31',
    home: [37.7749, -122.4194],
    avatarColor: '9d0208',
    sports: [],
    role: 'ADMIN',
    note: 'ADMIN: moderator rights plus creator verification.',
  },
  {
    key: 'pat',
    username: 'pending_pat',
    displayName: 'Pat Doyle',
    bio: 'Leaving soon.',
    location: 'Chicago, IL',
    birthDate: '1990-09-09',
    home: [41.8781, -87.6298],
    avatarColor: '999999',
    sports: [{ sport: 'running', relation: 'PARTICIPANT' }],
    note: 'Account scheduled for deletion (restricted mode); can still cancel it.',
  },
  {
    key: 'ulla',
    username: 'unverified_ulla',
    displayName: 'Ulla Berg',
    bio: 'Just signed up.',
    location: 'Minneapolis, MN',
    birthDate: '1995-04-04',
    home: [44.9778, -93.265],
    avatarColor: 'e0a458',
    emailVerified: false,
    sports: [{ sport: 'running', relation: 'PARTICIPANT' }],
    note: 'Email NOT verified: can log activities but not publish or comment.',
  },
];

/** Who follows whom (requests to private accounts are approved unless listed in PENDING). */
// Maya deliberately does NOT follow everyone: Explore, "who to follow" and trending topics stay
// interesting when you sign in as her.
export const FOLLOWS: ReadonlyArray<readonly [string, string]> = [
  ['maya', 'leo'],
  ['maya', 'dani'],
  ['maya', 'stride'],
  ['maya', 'priya'],
  ['leo', 'maya'],
  ['leo', 'dani'],
  ['leo', 'stride'],
  ['leo', 'tom'],
  ['leo', 'hana'],
  ['sora', 'maya'],
  ['sora', 'dani'],
  ['sora', 'tom'],
  ['dani', 'maya'],
  ['dani', 'leo'],
  ['dani', 'sora'],
  ['dani', 'ben'],
  ['dani', 'tom'],
  ['dani', 'hana'],
  ['stride', 'maya'],
  ['stride', 'leo'],
  ['stride', 'dani'],
  ['ben', 'dani'],
  ['ben', 'maya'],
  ['ben', 'tom'],
  ['priya', 'maya'],
  ['priya', 'dani'],
  ['quentin', 'maya'],
  ['tess', 'maya'],
  ['tess', 'dani'],
  ['tess', 'priya'],
  ['tom', 'maya'],
  ['tom', 'leo'],
  ['tom', 'sora'],
  ['tom', 'dani'],
  ['tom', 'hana'],
  ['hana', 'maya'],
  ['hana', 'tom'],
  ['hana', 'leo'],
  ['bob', 'maya'],
  ['bob', 'leo'],
  ['morgan', 'maya'],
  ['ulla', 'maya'],
  ['ulla', 'dani'],
  ['pat', 'maya'],
];

/** Follow requests to private accounts that stay pending. */
export const PENDING_REQUESTS: ReadonlyArray<readonly [string, string]> = [
  ['leo', 'priya'],
  ['sora', 'priya'],
];

export const SPORT_TITLES: Record<Sport, readonly string[]> = {
  running: [
    'Morning Run',
    'Easy recovery jog',
    'Tempo Tuesday',
    'Hill repeats',
    'Lunch Run',
    'Sunrise miles',
    'Track intervals',
    'Neighborhood loop',
    'Progression run',
  ],
  cycling: [
    'Morning Ride',
    'Gravel grinder',
    'Lunch Ride',
    'Climbing day',
    'Coffee ride',
    'Tempo spin',
    'Backroads loop',
  ],
  swimming: [
    'Pool session',
    'Drill-focused swim',
    'Open water dip',
    'Threshold sets',
    'Easy aerobic swim',
  ],
  strength_training: [
    'Leg day',
    'Upper body',
    'Full body strength',
    'Deadlift focus',
    'Push / Pull',
  ],
  hiking: ['Summit day', 'Trail wander', 'Ridge walk', 'Waterfall loop', 'Sunset hike'],
  triathlon: ['Brick session', 'Sprint triathlon', 'Race simulation'],
  walking: ['Recovery walk', 'Evening stroll'],
};

export const DESCRIPTIONS: readonly string[] = [
  'Felt strong today.',
  'Legs were heavy at first, then it clicked.',
  'Beautiful weather. Zero complaints.',
  'Slow and steady wins.',
  'Fueled well this time, big difference.',
  'Windy! Still happy I went out.',
  'New shoes feel great.',
  '',
  '',
  '',
];

export const CAPTIONS: Record<Sport, ReadonlyArray<{ text: string; topics: readonly string[] }>> = {
  running: [
    {
      text: 'Post-run clip: legs are cooked, sunrise made it worth it',
      topics: ['running', 'sunrise'],
    },
    {
      text: 'Tempo done. The last kilometre hurt in the best way',
      topics: ['speedwork', 'running'],
    },
    { text: 'Easy day means EASY. Learning this the slow way', topics: ['recovery', 'running'] },
    { text: 'Marathon block week 6: halfway there', topics: ['marathon', 'training'] },
    { text: 'Trail legs engaged', topics: ['trailrunning'] },
  ],
  cycling: [
    { text: 'Gravel loop: dust, descents and zero cars', topics: ['gravel', 'cycling'] },
    { text: 'That climb never gets easier, I just get slower', topics: ['climbing', 'cycling'] },
    { text: 'Coffee stop earned', topics: ['coffeeride', 'gravel'] },
  ],
  swimming: [
    { text: 'Drill day: catch-up freestyle is humbling', topics: ['swim', 'technique'] },
    { text: 'Lane 3 forever', topics: ['swim', 'masters'] },
  ],
  strength_training: [
    { text: 'Heavy triples felt smooth today', topics: ['strengthtraining', 'powerlifting'] },
    { text: 'Leg day survived', topics: ['strengthtraining', 'legday'] },
  ],
  hiking: [
    { text: 'Summit reached. Worth every step', topics: ['hiking', 'summit'] },
    { text: 'Golden hour on the ridge', topics: ['hiking', 'goldenhour'] },
  ],
  triathlon: [
    { text: 'Brick session done: jelly legs for the first km', topics: ['triathlon', 'brick'] },
  ],
  walking: [{ text: 'Recovery walk', topics: ['recovery'] }],
};

export const COMMENTS: readonly string[] = [
  'Great work! 🔥',
  'Love this',
  'Those splits are insane',
  'Inspiring, thanks for sharing',
  'Which route is this?',
  'Strong effort!',
  'Need to try this loop 👀',
  'Legend',
  'That view though',
  'Proud of you',
  'Respect',
  'Keep it up!',
];

export const REPLIES: readonly string[] = [
  'Thank you!! 🙏',
  'Appreciate it',
  'Happy to share the route',
  'Same to you!',
  'Come join next time',
  'Haha thanks',
];

/** Standalone (not tied to an activity) posts: the creator side of the platform. */
export interface StandalonePost {
  author: string;
  /** Days after the start of the story. */
  day: number;
  kind: 'video' | 'photo' | 'text';
  caption: string;
  topics: readonly string[];
  visibility?: 'PUBLIC' | 'FOLLOWERS';
  sponsorship?: {
    type: 'PAID_PARTNERSHIP' | 'GIFTED_PRODUCT' | 'AFFILIATE' | 'AMBASSADOR';
    brandName: string;
  };
  /** Tags another seeded account in the caption. */
  mentions?: readonly string[];
}

export const STANDALONE_POSTS: readonly StandalonePost[] = [
  {
    author: 'dani',
    day: 12,
    kind: 'video',
    caption: '3 drills that fixed my athletes’ cadence. Try them after an easy run',
    topics: ['running', 'technique', 'coaching'],
  },
  {
    author: 'dani',
    day: 24,
    kind: 'video',
    caption: 'Why your easy runs should feel EASY (and the talk test that proves it)',
    topics: ['training', 'running', 'recovery'],
  },
  {
    author: 'dani',
    day: 41,
    kind: 'photo',
    caption:
      'Race-week fueling plan, free download in my bio. Code DANI10 gets you 10% at checkout',
    topics: ['marathon', 'nutrition'],
    sponsorship: { type: 'AFFILIATE', brandName: 'Zoom Nutrition' },
  },
  {
    author: 'dani',
    day: 55,
    kind: 'text',
    caption:
      'Reminder: one hard day, one medium day, everything else easy. Shout-out to @maya_runs for living it.',
    topics: ['training'],
    mentions: ['maya'],
  },
  {
    author: 'leo',
    day: 9,
    kind: 'video',
    caption: 'Gravel loop above Bend, all dust and descents',
    topics: ['gravel', 'cycling', 'bikepacking'],
  },
  {
    author: 'leo',
    day: 30,
    kind: 'video',
    caption:
      'Testing the new Stride trail kit on a 60k gravel day. Paid partnership, honest review in the comments',
    topics: ['gravel', 'gear'],
    sponsorship: { type: 'PAID_PARTNERSHIP', brandName: 'Stride Running Co.' },
    mentions: ['stride'],
  },
  {
    author: 'leo',
    day: 47,
    kind: 'photo',
    caption: 'Dust, sunrise, repeat',
    topics: ['gravel', 'sunrise'],
  },
  {
    author: 'stride',
    day: 20,
    kind: 'video',
    caption: 'Meet the Flight 2: lighter, springier, built for long miles',
    topics: ['gear', 'running'],
  },
  {
    author: 'stride',
    day: 38,
    kind: 'photo',
    caption: 'Spring collection is live. Ambassadors, you know what to do',
    topics: ['gear'],
  },
  {
    author: 'maya',
    day: 33,
    kind: 'video',
    caption: 'Gifted a pair of the Flight 2 from @stride_running. Thoughts after 80 km: yes.',
    topics: ['gear', 'running'],
    sponsorship: { type: 'GIFTED_PRODUCT', brandName: 'Stride Running Co.' },
    mentions: ['stride'],
  },
  {
    author: 'ben',
    day: 15,
    kind: 'photo',
    caption: 'PR day: 140 kg x 3',
    topics: ['strengthtraining', 'powerlifting'],
  },
  {
    author: 'ben',
    day: 44,
    kind: 'photo',
    caption: 'Form check Friday',
    topics: ['strengthtraining', 'technique'],
  },
  {
    author: 'hana',
    day: 27,
    kind: 'photo',
    caption: 'Alta ridge at golden hour',
    topics: ['hiking', 'goldenhour'],
  },
  {
    author: 'sora',
    day: 18,
    kind: 'video',
    caption: 'Catch-up drill, slow motion. Notice the early catch',
    topics: ['swim', 'technique'],
  },
  {
    author: 'tom',
    day: 36,
    kind: 'video',
    caption: 'T1 practice: 38 seconds and dropping',
    topics: ['triathlon', 'transition'],
  },
  // A burst of recent posts on shared topics, so trending topics and topic pages have something to show.
  {
    author: 'maya',
    day: 51,
    kind: 'video',
    caption: 'Marathon block, week 14: the long run finally felt easy',
    topics: ['marathon', 'training'],
  },
  {
    author: 'dani',
    day: 52,
    kind: 'photo',
    caption: 'Taper week checklist for your goal marathon',
    topics: ['marathon', 'taper'],
  },
  {
    author: 'tom',
    day: 53,
    kind: 'video',
    caption: 'Marathon pace brick: 90 min bike then 10 km at goal pace',
    topics: ['marathon', 'triathlon'],
  },
  {
    author: 'hana',
    day: 52,
    kind: 'video',
    caption: 'Gravel connector to the trailhead, who knew',
    topics: ['gravel', 'hiking'],
  },
  {
    author: 'leo',
    day: 54,
    kind: 'video',
    caption: 'Gravel race prep: tubeless, 40 mm, zero regrets',
    topics: ['gravel', 'racing'],
  },
  {
    author: 'ben',
    day: 53,
    kind: 'photo',
    caption: 'Mobility Monday. Recovery is training too',
    topics: ['recovery', 'mobility'],
  },
  {
    author: 'sora',
    day: 54,
    kind: 'photo',
    caption: 'Recovery swim, no watch, just water',
    topics: ['recovery', 'swim'],
  },
  {
    author: 'bob',
    day: 50,
    kind: 'text',
    caption: 'AMAZING offer!!! DM me for crypto gains guaranteed, limited spots',
    topics: [],
  },
  {
    author: 'bob',
    day: 56,
    kind: 'text',
    caption: 'Last chance: crypto giveaway, follow and DM me now',
    topics: [],
  },
  {
    author: 'priya',
    day: 22,
    kind: 'photo',
    caption: 'Finished my first 10 miler. Private account, so this one is just for you lot',
    topics: ['running'],
    visibility: 'FOLLOWERS',
  },
  {
    author: 'tess',
    day: 28,
    kind: 'text',
    caption: 'New 5k PR at the meet today!',
    topics: ['crosscountry'],
    visibility: 'FOLLOWERS',
  },
];
