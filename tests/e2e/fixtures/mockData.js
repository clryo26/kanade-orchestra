const ORG_SETTINGS = [
  {
    id: 1,
    short_name: '奏オケ',
    portal_title: '奏オケポータル',
    logo_image: '',
    icon_image: '',
  },
];

const PART_SETTINGS = [
  { id: 1, part_name: 'Violin', sort_order: 1 },
  { id: 2, part_name: 'Cello', sort_order: 2 },
  { id: 3, part_name: 'Flute', sort_order: 3 },
];

const SNS_SETTINGS = [
  {
    id: 1,
    x_url: 'https://twitter.com/kanade_orche',
    facebook_url: 'https://facebook.com/zouokesutora',
    instagram_url: 'https://instagram.com/kanade.orchestra',
    youtube_url: 'https://www.youtube.com/@fukuoka-kanade-orchestra',
  },
];

const PERFORMANCE = {
  id: 1,
  title: '第1回定期演奏会',
  date: '2026-08-20',
  pieces: [
    { title: '交響曲第5番', composer: 'ベートーヴェン', alias: 'ベト5', duration: '35' },
  ],
};

const SCHEDULE = {
  id: 1,
  date: '2026-07-15',
  time: '13:00-16:30',
  start_time: '13:00',
  end_time: '16:30',
  venue: '市民センター',
  performance_id: 1,
  performance_title: '第1回定期演奏会',
  pieces: 'ベト5',
  notes: '合奏',
};

const ANNOUNCEMENT = {
  id: 1,
  date: '2026-07-01',
  title: '連絡事項',
  content: '今週は時間厳守でお願いします。',
};

const MEMBER = {
  id: 1,
  name: 'テスト太郎',
  last_name: 'テスト',
  first_name: '太郎',
  last_name_kana: 'てすと',
  first_name_kana: 'たろう',
  part: 'Violin',
  permission: '一般',
  password_set: true,
};

const BOOTSTRAP_DATA = {
  performances: [PERFORMANCE],
  schedules: [SCHEDULE],
  announcements: [ANNOUNCEMENT],
  events: [],
  members: [MEMBER],
  recordings: {
    files: [
      {
        id: 'rec-1',
        name: '2026-07-15_ベト5.mp3',
        date: '2026-07-15',
        piece: 'ベト5',
        source: 'local',
        path: 'converted/2026-07-15/ベト5/rec.mp3',
        play_url: '/api/recordings/play/converted/2026-07-15/ベト5/rec.mp3',
        download_url: '/api/recordings/download/converted/2026-07-15/ベト5/rec.mp3',
        duration: '03:21',
      },
    ],
  },
  sheets: {
    files: [
      {
        id: 'sheet-1',
        name: 'ベト5_Vn1.pdf',
        performance_id: 1,
        piece: 'ベト5',
        part: 'Violin',
        url: '/api/sheets/view/sheet-1',
        view_url: '/api/sheets/view/sheet-1',
        download_url: '/api/sheets/download/sheet-1',
      },
    ],
  },
  auth_devices: [],
  extras: {
    absences: [],
    event_responses: [],
    date_adjustments: [],
    date_adjustment_responses: [],
    sheet_library: [],
    payments: [],
    castings: [],
    piece_infos: [],
    practice_instructions: [],
    performance_day_infos: [],
    desired_pieces: [],
    promotions: [],
    concert_record_videos: [],
    albums: [],
    part_settings: PART_SETTINGS,
    venue_settings: [{ id: 1, name: '市民センター', type: 'practice' }],
    flyer_distributions: [],
    flyer_distribution_assignments: [],
    org_settings: ORG_SETTINGS,
    sns_settings: SNS_SETTINGS,
    connection_settings: [],
  },
  cloudRunRevision: 'test-revision',
};

module.exports = {
  PART_SETTINGS,
  ORG_SETTINGS,
  SNS_SETTINGS,
  BOOTSTRAP_DATA,
};
