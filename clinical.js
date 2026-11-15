// Examination technique: where, which side, how, how long.
//
// Knowing that pitting oedema is checked over the medial malleolus is not the same as putting your
// thumb there with an examiner watching. Every technique here is done on a drawn patient: you choose
// how the patient lies, which side of the bed you stand, then touch the exact spot — and hold it for
// as long as you would really press. Each part is checked separately, so "explained it perfectly,
// then pressed the lateral malleolus" or "JVP on the left" is caught and corrected.
//
// The drawings face you, as a patient does: the PATIENT'S RIGHT IS ON YOUR LEFT. That is part of the drill.

const SKIN = 'var(--skin, #e3b996)';
const BODY = {
  // ---- lower legs and feet, from the front ----
  legs: {
    title: 'Lower legs and feet', sides: true,
    svg: `<path class="bd" d="M64 8 L116 8 L112 188 Q114 204 108 212 L72 212 Q66 204 70 188 Z"/>
      <path class="bd" d="M184 8 L236 8 L230 188 Q234 204 228 212 L192 212 Q186 204 188 188 Z"/>
      <circle class="bd" cx="114" cy="196" r="8"/><circle class="bd" cx="67" cy="206" r="7"/>
      <circle class="bd" cx="186" cy="196" r="8"/><circle class="bd" cx="233" cy="206" r="7"/>
      <path class="bd" d="M70 210 L112 210 L128 284 Q90 296 52 284 Z"/><path class="bd" d="M188 210 L230 210 L248 284 Q210 296 172 284 Z"/>
      <path class="ln" d="M90 30 L90 180"/><path class="ln" d="M210 30 L210 180"/>`,
    marks: {
      shinR: { x: 90, y: 140, r: 22, label: "front of the shin, lower third (patient's right)" },
      shinL: { x: 210, y: 140, r: 22, label: "front of the shin, lower third (patient's left)" },
      medMalR: { x: 114, y: 196, r: 12, label: "medial malleolus (patient's right)" },
      latMalR: { x: 67, y: 206, r: 12, label: "lateral malleolus (patient's right)" },
      medMalL: { x: 186, y: 196, r: 12, label: "medial malleolus (patient's left)" },
      latMalL: { x: 233, y: 206, r: 12, label: "lateral malleolus (patient's left)" },
      dorsumR: { x: 90, y: 250, r: 20, label: "dorsum of the foot (patient's right)" },
      dorsumL: { x: 210, y: 250, r: 20, label: "dorsum of the foot (patient's left)" }
    }
  },
  // ---- neck and upper chest, from the front ----
  neck: {
    title: 'Neck and upper chest', sides: true,
    svg: `<path class="bd" d="M86 40 L214 40 L236 196 Q266 202 292 236 L292 300 L8 300 L8 236 Q34 202 64 196 Z"/>
      <ellipse class="bd" cx="150" cy="10" rx="74" ry="46"/>
      <path class="ln" d="M150 212 L40 202 M150 212 L260 202"/>
      <path class="ln m" d="M94 52 L142 210 M94 52 L112 204"/><path class="ln m" d="M206 52 L158 210 M206 52 L188 204"/>
      <path class="ln v" d="M96 76 Q88 140 80 198"/><path class="ln v" d="M204 76 Q212 140 220 198"/>
      <rect class="ln" x="140" y="98" width="20" height="22" rx="6"/>
      <path class="ln" d="M150 214 L150 300 M138 262 L162 262"/>`,
    marks: {
      ijvR: { x: 125, y: 186, r: 15, label: "right internal jugular — between the two heads of the right sternocleidomastoid" },
      ijvL: { x: 175, y: 186, r: 15, label: "left internal jugular" },
      ejvR: { x: 88, y: 140, r: 12, label: "right external jugular vein" },
      ejvL: { x: 212, y: 140, r: 12, label: "left external jugular vein" },
      carR: { x: 118, y: 112, r: 13, label: "right carotid — medial to the sternocleidomastoid at the upper border of the thyroid cartilage" },
      carL: { x: 182, y: 112, r: 13, label: "left carotid" },
      thyroid: { x: 150, y: 109, r: 10, label: 'thyroid cartilage' },
      notch: { x: 150, y: 214, r: 11, label: 'suprasternal notch' },
      angle: { x: 150, y: 262, r: 13, label: 'sternal angle (angle of Louis)' },
      clavR: { x: 90, y: 205, r: 14, label: "right clavicle" }
    }
  },
  // ---- one eye, lower lid gently pulled down ----
  eye: {
    title: 'Eye — lower lid pulled down',
    svg: `<path class="bd" d="M20 150 Q150 30 280 150 Q150 270 20 150 Z"/>
      <path class="white" d="M44 150 Q150 62 256 150 Q150 222 44 150 Z"/>
      <circle class="iris" cx="150" cy="150" r="36"/><circle class="pupil" cx="150" cy="150" r="14"/>
      <path class="conj" d="M62 196 Q150 238 238 196 Q150 262 62 196 Z"/>
      <path class="ln" d="M40 140 Q150 40 260 140"/>`,
    marks: {
      lowerConj: { x: 150, y: 226, r: 20, label: 'lower palpebral conjunctiva' },
      upperSclera: { x: 150, y: 96, r: 18, label: 'upper bulbar conjunctiva over the sclera' },
      sideSclera: { x: 82, y: 150, r: 18, label: 'sclera at the side of the iris' },
      cornea: { x: 150, y: 150, r: 30, label: 'cornea / iris' },
      upperLid: { x: 150, y: 58, r: 18, label: 'skin of the upper eyelid' }
    }
  },
  // ---- mouth open, tongue raised ----
  mouth: {
    title: 'Mouth — tongue raised',
    svg: `<ellipse class="bd" cx="150" cy="150" rx="128" ry="118"/>
      <path class="lip" d="M60 120 Q150 70 240 120 Q150 100 60 120 Z"/><path class="lip" d="M60 190 Q150 250 240 190 Q150 214 60 190 Z"/>
      <path class="oral" d="M64 122 Q150 104 236 122 L236 188 Q150 212 64 188 Z"/>
      <path class="tongue" d="M92 186 Q100 112 150 106 Q200 112 208 186 Z"/>
      <path class="ln" d="M150 140 L150 186"/>`,
    marks: {
      underTongue: { x: 150, y: 168, r: 22, label: 'undersurface of the tongue' },
      lips: { x: 150, y: 92, r: 18, label: 'lips' },
      lowerLip: { x: 150, y: 222, r: 16, label: 'lower lip' },
      cheek: { x: 74, y: 150, r: 16, label: 'inside of the cheek' }
    }
  },
  // ---- patient's right hand palm up, and fingertips from above ----
  hand: {
    title: "Patient's right wrist (palm up) · fingertips",
    svg: `<path class="bd" d="M38 300 L36 196 Q24 150 30 96 L58 96 L60 60 L80 60 L82 48 L102 48 L104 60 L122 62 L126 120 Q132 170 124 196 L122 300 Z"/>
      <path class="bd" d="M30 150 Q8 132 14 100 Q22 92 32 104 L40 140 Z"/>
      <path class="ln" d="M36 200 Q80 210 124 200"/><path class="ln" d="M60 240 L58 296 M104 240 L106 296"/>
      ${[175, 205, 235, 265].map((x, i) => `<rect class="bd" x="${x - 12}" y="${70 - (i === 2 ? 10 : 0)}" width="24" height="${150 + (i === 2 ? 10 : 0)}" rx="12"/><rect class="nail" x="${x - 9}" y="${74 - (i === 2 ? 10 : 0)}" width="18" height="24" rx="6"/>`).join('')}
      <text class="vt" x="80" y="292" text-anchor="middle">wrist (palm up)</text><text class="vt" x="220" y="250" text-anchor="middle">fingertips, nails up</text>`,
    marks: {
      radial: { x: 46, y: 224, r: 14, label: 'radial artery — thumb side of the front of the wrist' },
      ulnar: { x: 116, y: 224, r: 14, label: 'ulnar artery — little-finger side of the wrist' },
      midWrist: { x: 82, y: 222, r: 12, label: 'middle of the wrist (flexor tendons)' },
      thenar: { x: 44, y: 150, r: 14, label: 'thenar eminence' },
      palm: { x: 86, y: 130, r: 18, label: 'palm and its creases' },
      nail: { x: 235, y: 74, r: 16, label: 'nail bed' },
      nail1: { x: 175, y: 84, r: 14, label: 'nail bed' },
      nail2: { x: 205, y: 84, r: 14, label: 'nail bed' },
      nail4: { x: 265, y: 84, r: 14, label: 'nail bed' },
      pulp: { x: 235, y: 170, r: 16, label: 'finger pulp' }
    }
  },
  // ---- chest, from the front ----
  chest: {
    title: 'Chest — count down from the sternal angle', sides: true,
    svg: `<path class="bd" d="M30 10 L270 10 L250 300 L50 300 Z"/>
      <path class="ln" d="M150 26 L44 18 M150 26 L256 18"/><rect class="ln" x="140" y="26" width="20" height="200" rx="6"/>
      <path class="ln" d="M136 70 L164 70"/>
      ${[70, 100, 130, 160, 190, 220].map(y => `<path class="rib" d="M162 ${y} Q205 ${y + 8} 250 ${y + 20}"/><path class="rib" d="M138 ${y} Q95 ${y + 8} 50 ${y + 20}"/>`).join('')}
      <circle class="ln" cx="206" cy="146" r="5"/><circle class="ln" cx="94" cy="146" r="5"/>`,
    marks: {
      apexOk: { x: 198, y: 177, r: 13, label: "left 5th intercostal space, just medial to the mid-clavicular line" },
      ics4: { x: 202, y: 147, r: 12, label: "left 4th intercostal space" },
      displaced: { x: 238, y: 212, r: 16, label: "left 6th space, anterior axillary line (displaced)" },
      lse: { x: 168, y: 176, r: 12, label: "left sternal edge, 5th space" },
      rightApex: { x: 102, y: 177, r: 13, label: "right 5th intercostal space" },
      angleC: { x: 150, y: 70, r: 12, label: 'sternal angle — level of the 2nd rib' }
    }
  },
  // ---- abdomen, from the front ----
  abdomen: {
    title: 'Abdomen', sides: true,
    svg: `<path class="bd" d="M40 6 L260 6 L262 294 L38 294 Z"/>
      <path class="ln" d="M150 26 L58 98 M150 26 L242 98"/><circle class="ln" cx="150" cy="160" r="7"/>
      <path class="ln" d="M58 246 Q100 268 132 294 M242 246 Q200 268 168 294"/>`,
    marks: {
      rif: { x: 86, y: 234, r: 22, label: "right iliac fossa" },
      lif: { x: 214, y: 234, r: 22, label: "left iliac fossa" },
      rhc: { x: 92, y: 112, r: 18, label: "right hypochondrium, just below the costal margin" },
      lhc: { x: 208, y: 112, r: 18, label: "left hypochondrium" },
      murphy: { x: 96, y: 72, r: 13, label: "right costal margin at the mid-clavicular line (tip of the 9th costal cartilage)" },
      murphyL: { x: 204, y: 72, r: 13, label: "left costal margin" },
      epi: { x: 150, y: 80, r: 16, label: 'epigastrium' },
      umb: { x: 150, y: 160, r: 14, label: 'umbilicus' },
      flankR: { x: 52, y: 166, r: 16, label: "right flank" },
      flankL: { x: 248, y: 166, r: 16, label: "left flank" }
    }
  },
  // ---- knee, from the front ----
  knee: {
    title: 'Knee, slightly bent',
    svg: `<path class="bd" d="M96 0 L204 0 L196 150 Q208 200 186 300 L114 300 Q92 200 104 150 Z"/>
      <ellipse class="bd2" cx="150" cy="120" rx="30" ry="38"/><rect class="tendon" x="141" y="158" width="18" height="70" rx="8"/>
      <ellipse class="ln" cx="150" cy="242" rx="16" ry="10"/>`,
    marks: {
      tendon: { x: 150, y: 192, r: 15, label: 'patellar tendon, just below the patella' },
      patella: { x: 150, y: 120, r: 26, label: 'patella' },
      quads: { x: 150, y: 42, r: 26, label: 'quadriceps (thigh)' },
      tuberosity: { x: 150, y: 244, r: 14, label: 'tibial tuberosity' }
    }
  },
  // ---- patient's right arm at the elbow, from the front ----
  arm: {
    title: "Patient's right arm — front of the elbow (their body is to your right)",
    svg: `<path class="bd" d="M104 0 L196 0 L200 170 L190 300 L110 300 L100 170 Z"/>
      <path class="ln" d="M100 170 Q150 184 200 170"/><rect class="tendon" x="142" y="140" width="16" height="44" rx="7"/>
      <path class="art" d="M170 0 Q172 90 172 176"/><text class="vt" x="150" y="290" text-anchor="middle">forearm</text>`,
    marks: {
      brachial: { x: 172, y: 172, r: 11, label: 'brachial artery — medial to the biceps tendon' },
      lateralFossa: { x: 128, y: 172, r: 11, label: 'lateral to the biceps tendon' },
      bicepsT: { x: 150, y: 164, r: 9, label: 'biceps tendon' },
      cuffOk: { x: 150, y: 120, r: 22, label: 'upper arm, lower edge 2–3 cm above the elbow crease' },
      cuffLow: { x: 150, y: 174, r: 14, label: 'over the elbow crease' },
      cuffHigh: { x: 150, y: 30, r: 22, label: 'high on the upper arm' }
    }
  }
};

const POSITIONS = { supine: 'Lying flat', reclined: 'Reclining at 45°', sitting: 'Sitting up', legsHanging: 'Sitting, legs hanging free' };

/**
 * The techniques. `taps` are the touches, in order; `hold` is how long a press must last, in
 * seconds. `steps` are the method questions examiners ask while watching. `finding` names the
 * entry a case's examination findings are filed under.
 */
const TECHNIQUES = [
  { id: 'oedema', group: 'General', name: 'Pitting oedema', finding: 'oedema',
    pos: { ok: ['supine', 'sitting', 'reclined'] }, stand: 'right',
    taps: [{ view: 'legs', ask: 'Check for pitting oedema — press and hold where you would press.', ok: ['medMalR', 'medMalL', 'shinR', 'shinL'], also: { dorsumR: 'The dorsum works too, but the standard site is over the medial malleolus or the shin, over bone.', dorsumL: 'The dorsum works too, but the standard site is over the medial malleolus or the shin, over bone.' },
      wrong: { latMalR: 'That is the LATERAL malleolus. Pitting oedema is checked over the MEDIAL malleolus (inner side of the ankle) or the lower shin — over bone, so there is something firm to press against.', latMalL: 'That is the LATERAL malleolus. Pitting oedema is checked over the MEDIAL malleolus (inner side of the ankle) or the lower shin.' },
      hold: [10, 15], holdWhy: 'Press firmly with the thumb for 10–15 seconds, then look and feel for the pit.' }],
    steps: [{ ask: 'Before pressing, you…', options: ['Ask if the leg is tender and watch the face as you press', 'Press as hard as possible straight away', 'Ask the patient to stand'], answer: 0, why: 'Oedematous legs can be tender — ask, and watch the face.' },
      { ask: 'In a patient confined to bed, also check…', options: ['The sacrum', 'The forehead', 'The palms'], answer: 0, why: 'Fluid collects where the body is lowest: the sacrum in someone lying in bed.' }],
    teach: 'Medial malleolus or lower third of the shin, over bone; thumb pressure 10–15 s; then the sacrum if bedbound. Ask about tenderness first.' },

  { id: 'jvp', group: 'General', name: 'Jugular venous pressure', finding: 'jvp',
    pos: { ok: ['reclined'], why: 'At 45° the top of the column normally sits just above the clavicle, where it can be seen.' }, stand: 'right',
    taps: [{ view: 'neck', ask: 'Where do you look for the JVP? Touch it.', ok: ['ijvR'],
      wrong: { ijvL: 'Wrong side. The JVP is assessed on the RIGHT: the right internal jugular runs in a straight line through the SVC to the right atrium. The left can read falsely high.', ejvR: 'That is the external jugular. It can be kinked or obstructed — use the internal jugular, between the two heads of the sternocleidomastoid.', ejvL: 'External jugular, and the left side — use the RIGHT internal jugular.', carR: 'That is the carotid pulse, medial to the sternocleidomastoid higher up. The internal jugular is lower, between the two heads of the muscle.' } },
      { view: 'neck', ask: 'Measure the height of the column — from which point?', ok: ['angle'], wrong: { notch: 'Measure the vertical height from the STERNAL ANGLE, not the suprasternal notch.', clavR: 'Measure the vertical height from the sternal angle, not the clavicle.' } }],
    steps: [{ ask: 'The head is…', options: ['Turned slightly to the left, chin a little up, on a pillow', 'Turned fully to the right', 'Flexed onto the chest'], answer: 0, why: 'Slightly away from the side you are looking at, neck muscles relaxed. Turning fully tightens the sternocleidomastoid and hides the vein.' },
      { ask: 'Lighting:', options: ['A torch shone tangentially across the neck, from the side', 'A torch shone straight at the neck', 'No light is needed'], answer: 0, why: 'Light from the side throws shadows that make the soft venous pulsation visible.' },
      { ask: 'Which tells it is venous, not the carotid?', options: ['Double wave, not palpable, falls on inspiration, rises with abdominal pressure', 'Single sharp beat that you can feel', 'It does not change with position'], answer: 0, why: 'Venous pulsation: biphasic, impalpable, obliterated by gentle pressure at the root of the neck, varies with respiration and position, rises with hepatojugular reflux.' },
      { ask: 'You measure the height with…', options: ['Two scales: one held vertical on the sternal angle, the other horizontal from the top of the pulsation across to it', 'A tape laid along the slope of the neck', 'An estimate by eye'], answer: 0, why: 'The horizontal scale carries the top of the column across to the vertical one; read the vertical height in centimetres.' },
      { ask: 'Normal JVP is up to…', options: ['3–4 cm above the sternal angle', '10 cm above the sternal angle', 'Level with the earlobe'], answer: 0, why: 'Up to about 3–4 cm vertically above the sternal angle (≈ 8 cm of water above the right atrium).' }],
    teach: 'Patient at 45°, you on the right, head slightly to the left. Right internal jugular, between the heads of the sternocleidomastoid. Vertical height above the sternal angle.' },

  { id: 'pallor', group: 'General', name: 'Pallor', finding: 'pallor', stand: 'right',
    taps: [{ view: 'eye', ask: 'Where do you look for pallor in the eye?', ok: ['lowerConj'], wrong: { upperSclera: 'The sclera is where you look for ICTERUS. Pallor is seen in the lower palpebral conjunctiva.', sideSclera: 'That is sclera — for icterus. Pallor: the lower palpebral conjunctiva.', cornea: 'Not the cornea. Pull the lower lid down gently and look at the palpebral conjunctiva.' } }],
    steps: [{ ask: 'You ask the patient to…', options: ['Look up while you gently pull the lower lid down', 'Look down while you lift the upper lid', 'Close both eyes'], answer: 0, why: 'Looking up exposes the lower palpebral conjunctiva.' },
      { ask: 'Other sites for pallor:', options: ['Tongue, palms and palmar creases, nail beds', 'Sclera and skin of the face', 'Soles only'], answer: 0, why: 'Tongue, palmar creases, nail beds, and the conjunctiva.' }],
    teach: 'Lower palpebral conjunctiva, patient looking up; also tongue, palms, nail beds.' },

  { id: 'icterus', group: 'General', name: 'Icterus', finding: 'icterus', stand: 'right',
    taps: [{ view: 'eye', ask: 'Where do you look for icterus?', ok: ['upperSclera'], also: { sideSclera: 'Sclera is right — but the classic site is the upper bulbar conjunctiva, with the patient looking down.' }, wrong: { lowerConj: 'That is where you look for PALLOR. Icterus: the sclera — upper bulbar conjunctiva, patient looking down.', cornea: 'Not the cornea — the sclera.' } }],
    steps: [{ ask: 'You ask the patient to…', options: ['Look down while you lift the upper lid', 'Look up while you pull the lower lid', 'Look straight at a light'], answer: 0, why: 'Looking down exposes the upper sclera, where the yellow shows first.' },
      { ask: 'The light should be…', options: ['Natural daylight', 'Yellow tube light', 'A torch only'], answer: 0, why: 'Artificial (yellowish) light hides mild jaundice.' }],
    teach: 'Upper bulbar conjunctiva, patient looking down, in daylight; also undersurface of the tongue and palate.' },

  { id: 'cyanosis', group: 'General', name: 'Central cyanosis', finding: 'cyanosis', stand: 'right',
    taps: [{ view: 'mouth', ask: 'Where do you look for central cyanosis?', ok: ['underTongue'], also: { lips: 'Lips are used, but the undersurface of the tongue is the most reliable site.' } }],
    steps: [{ ask: 'Peripheral cyanosis is looked for at…', options: ['Nail beds and fingertips, tip of the nose, earlobes', 'Undersurface of the tongue', 'The conjunctiva'], answer: 0, why: 'Peripheral: the extremities. Central: tongue and oral mucosa.' }],
    teach: 'Undersurface of the tongue and oral mucosa in good light; peripheral at nail beds, nose, ears.' },

  { id: 'clubbing', group: 'General', name: 'Clubbing', finding: 'clubbing', stand: 'right',
    taps: [{ view: 'hand', ask: 'Where do you look for clubbing?', ok: ['nail', 'nail1', 'nail2', 'nail4'], wrong: { pulp: 'Look at the nail bed and its angle, not the pulp alone.', radial: 'That is the wrist.' } }],
    steps: [{ ask: "Schamroth's test:", options: ['Back of the terminal phalanges of the same fingers placed together — the diamond window is lost', 'Press the nail and time the refill', 'Shine a torch through the finger'], answer: 0, why: 'Normally a diamond-shaped window appears; in clubbing it is obliterated.' },
      { ask: 'The earliest sign is…', options: ['Fluctuation (bogginess) of the nail bed', 'Drumstick fingers', 'Curved nails only'], answer: 0, why: 'Grade 1: increased fluctuation of the nail bed, before the angle is lost.' }],
    teach: "Look along the nail from the side; Schamroth's window; nail-bed fluctuation first." },

  { id: 'pulse', group: 'CVS', name: 'Radial pulse', finding: 'pulse', stand: 'right',
    taps: [{ view: 'hand', ask: 'Feel the radial pulse.', ok: ['radial'], wrong: { ulnar: 'That is the ULNAR artery. The radial is on the THUMB side of the front of the wrist.', midWrist: 'Too central — that is over the tendons. Move to the thumb side.' } }],
    steps: [{ ask: 'Count it for…', options: ['A full minute', '15 seconds × 4', '10 seconds × 6'], answer: 0, why: 'A full minute, so an irregular rhythm or a pulse deficit is not missed.' },
      { ask: 'Then compare…', options: ['Both radials together (radio-radial), and radial with femoral (radio-femoral)', 'Radial with carotid at the same time on both sides', 'Nothing else'], answer: 0, why: 'Radio-radial delay (subclavian narrowing, aortic arch), radio-femoral delay (coarctation).' },
      { ask: 'Use…', options: ['Index and middle (and ring) fingertips', 'Your thumb', 'The flat of the palm'], answer: 0, why: 'Your thumb has its own pulse.' }],
    teach: 'Thumb side of the wrist, two or three fingertips, a full minute; rate, rhythm, volume, character; compare both sides and with the femoral.' },

  { id: 'bp', group: 'CVS', name: 'Blood pressure', finding: 'bp',
    pos: { ok: ['sitting', 'supine'] }, stand: 'right',
    taps: [{ view: 'arm', ask: 'Put the cuff on — touch where its lower edge sits.', ok: ['cuffOk'], wrong: { cuffLow: 'Too low: the cuff would cover the elbow crease where the stethoscope goes. Lower edge 2–3 cm above it.', cuffHigh: 'Too high — lower edge about 2–3 cm above the elbow crease.' } },
      { view: 'arm', ask: 'Now place the stethoscope.', ok: ['brachial'], wrong: { lateralFossa: 'That is LATERAL to the biceps tendon. The brachial artery is MEDIAL to it — towards the body.', bicepsT: 'That is the biceps tendon itself. The brachial artery lies just medial to it.' } }],
    steps: [{ ask: 'First, inflate while feeling the radial pulse until it disappears, because…', options: ['It estimates systolic, so you inflate 20–30 above it and do not miss an auscultatory gap', 'It warms the arm', 'It is only needed in children'], answer: 0, why: 'The palpatory method prevents a falsely low systolic from the auscultatory gap.' },
      { ask: 'Deflate at…', options: ['2–3 mmHg per second', '10 mmHg per second', 'All at once'], answer: 0, why: 'Slow enough to read the first and last sounds accurately.' },
      { ask: 'The arm should be…', options: ['Supported at the level of the heart', 'Hanging down by the side', 'Raised above the head'], answer: 0, why: 'Below heart level reads high; above reads low.' }],
    teach: 'Rested, arm supported at heart level, right cuff size, lower edge 2–3 cm above the crease; palpatory first; stethoscope medial to the biceps tendon; 2–3 mmHg/s.' },

  { id: 'crt', group: 'CVS', name: 'Capillary refill time', finding: 'crt', stand: 'right',
    taps: [{ view: 'hand', ask: 'Press for capillary refill — press and hold as you would.', ok: ['nail', 'nail1', 'nail2', 'nail4', 'pulp'], hold: [4, 6], holdWhy: 'Press for 5 seconds, release, and count until the colour returns.' }],
    steps: [{ ask: 'Normal refill is…', options: ['Under 2 seconds', 'Under 5 seconds', 'Under 10 seconds'], answer: 0, why: 'Normal is under 2 seconds (up to 3 in some guidelines); the hand at heart level.' }],
    teach: 'Press the nail bed (or the sternum in children) for 5 s at heart level; normal under 2 s.' },

  { id: 'carotid', group: 'CVS', name: 'Carotid pulse', finding: 'carotid', stand: 'right',
    taps: [{ view: 'neck', ask: 'Feel the carotid pulse.', ok: ['carR', 'carL'], wrong: { ijvR: 'Too low and too lateral — that is where the internal jugular is seen. The carotid is higher, medial to the sternocleidomastoid at the upper border of the thyroid cartilage.', thyroid: 'That is the thyroid cartilage itself. Slide laterally to the groove beside it.' } }],
    steps: [{ ask: 'Never…', options: ['Press both carotids at the same time', 'Use two fingers', 'Feel it with the patient lying down'], answer: 0, why: 'Pressing both can drop cerebral blood flow and trigger a vagal response.' }],
    teach: 'One side at a time, medial to the sternocleidomastoid at the upper border of the thyroid cartilage; character and volume.' },

  { id: 'apex', group: 'CVS', name: 'Apex beat', finding: 'apex',
    pos: { ok: ['supine', 'reclined'] }, stand: 'right',
    taps: [{ view: 'chest', ask: 'Where is a normal apex beat? (Count the ribs from the sternal angle.)', ok: ['apexOk'], wrong: { ics4: 'One space too high — that is the 4th space. Normal apex: 5th intercostal space, just medial to the mid-clavicular line.', displaced: 'That is a displaced apex (6th space, anterior axillary line), as in cardiomegaly. Normal is the 5th space just medial to the mid-clavicular line.', lse: 'Too medial — the left sternal edge. Normal apex is at the mid-clavicular line.', rightApex: 'That is the right side — only in dextrocardia.' } }],
    steps: [{ ask: 'The apex beat is defined as…', options: ['The lowermost and outermost point of definite cardiac impulse', 'The point of maximum impulse anywhere', 'Where the heart sounds are loudest'], answer: 0, why: 'Lowermost and outermost point of definite cardiac impulse.' },
      { ask: 'You find it by…', options: ['Flat palm first, then localising with a fingertip', 'Fingertip only, starting at the axilla', 'Percussion'], answer: 0, why: 'Palm to find the area, fingertip to localise and count the space.' }],
    teach: 'Count from the sternal angle (2nd rib): left 5th space, just medial to the mid-clavicular line; palm then fingertip.' },

  { id: 'trachea', group: 'Respiratory', name: 'Position of the trachea', finding: 'trachea',
    pos: { ok: ['sitting'] }, stand: 'right',
    taps: [{ view: 'neck', ask: 'Where do you feel for the trachea?', ok: ['notch'], wrong: { thyroid: 'Higher up is the thyroid cartilage. Feel in the suprasternal notch.', angle: 'That is the sternal angle. The trachea is felt in the suprasternal notch.' } }],
    steps: [{ ask: 'The patient sits with…', options: ['The chin in the midline, neck slightly flexed', 'The head turned to one side', 'The neck fully extended'], answer: 0, why: 'A turned head shifts the trachea and gives a false result.' },
      { ask: 'You judge position by…', options: ['Comparing the space between the trachea and each sternocleidomastoid', 'Its colour', 'Asking the patient to swallow only'], answer: 0, why: 'Equal spaces on both sides = central.' }],
    teach: 'Sitting, chin midline, neck slightly flexed; index finger in the suprasternal notch; compare the gaps on each side.' },

  { id: 'liver', group: 'Abdomen', name: 'Palpating the liver', finding: 'liver',
    pos: { ok: ['supine'], why: 'Flat on one pillow, arms by the sides, knees bent to relax the abdominal wall.' }, stand: 'right',
    taps: [{ view: 'abdomen', ask: 'Where do you START palpating for the liver?', ok: ['rif'], wrong: { rhc: 'Starting just under the costal margin misses a big liver whose edge is already lower down. Start in the RIGHT ILIAC FOSSA and work up.', lif: 'Left iliac fossa is not where the liver grows. Start in the RIGHT iliac fossa.', epi: 'Start low — the right iliac fossa — and work up towards the costal margin.' } }],
    steps: [{ ask: 'You move your hand up…', options: ['A little at a time, keeping it still as the patient breathes in', 'Quickly, pressing hard', 'Only when the patient holds their breath out'], answer: 0, why: 'On inspiration the liver descends to meet your still fingers; advance during expiration.' }],
    teach: 'Supine, knees bent; from the right iliac fossa upwards, hand still during inspiration, edge of index finger parallel to the costal margin.' },

  { id: 'spleen', group: 'Abdomen', name: 'Palpating the spleen', finding: 'spleen',
    pos: { ok: ['supine'] }, stand: 'right',
    taps: [{ view: 'abdomen', ask: 'Where do you START palpating for the spleen?', ok: ['rif'], wrong: { lhc: 'Starting high on the left misses a large spleen. It enlarges towards the RIGHT iliac fossa — start there.', lif: 'Start in the RIGHT iliac fossa — a spleen enlarges diagonally across the abdomen towards it.' } }],
    steps: [{ ask: 'You move…', options: ['Diagonally towards the left costal margin', 'Straight up the right side', 'Straight across to the left flank'], answer: 0, why: 'The spleen enlarges along its long axis, downwards and medially towards the right iliac fossa.' },
      { ask: 'If not felt, you…', options: ['Roll the patient onto their right side and feel again', 'Stop', 'Percuss the right flank'], answer: 0, why: 'Right lateral position brings a slightly enlarged spleen forward.' }],
    teach: 'From the right iliac fossa, diagonally to the left costal margin, with breathing; then right lateral position.' },

  { id: 'murphy', group: 'Abdomen', name: "Murphy's sign", finding: 'murphy',
    pos: { ok: ['supine'] }, stand: 'right',
    taps: [{ view: 'abdomen', ask: "Where do you press for Murphy's sign?", ok: ['murphy'], wrong: { murphyL: 'Left side. Murphy\'s sign is elicited at the RIGHT costal margin, mid-clavicular line.', rhc: 'Close, but go to the costal margin itself at the mid-clavicular line — the tip of the 9th costal cartilage.', epi: 'That is the epigastrium.' } }],
    steps: [{ ask: 'Positive when…', options: ['The patient catches their breath in pain on deep inspiration — and not on the left side', 'There is pain anywhere on pressing', 'A mass is felt'], answer: 0, why: 'Inspiratory arrest from the inflamed gallbladder meeting your fingers; checking the left side confirms it is specific.' }],
    teach: 'Fingers at the right costal margin, mid-clavicular line; deep breath in; arrest of inspiration with pain; negative on the left.' },

  { id: 'shifting', group: 'Abdomen', name: 'Shifting dullness', finding: 'ascites',
    pos: { ok: ['supine'] }, stand: 'right',
    taps: [{ view: 'abdomen', ask: 'Where do you START percussing?', ok: ['umb'], wrong: { flankR: 'Start at the umbilicus and percuss outwards to the flank.', epi: 'Start at the umbilicus.' } },
      { view: 'abdomen', ask: 'Percuss outwards — where does it turn dull? Keep your finger there.', ok: ['flankL', 'flankR'] }],
    steps: [{ ask: 'With your finger on the dull spot, you…', options: ['Roll the patient towards the opposite side and wait about 30 seconds before percussing again', 'Percuss again at once', 'Sit the patient up'], answer: 0, why: 'The fluid needs time to move; dull turning resonant = shifting dullness.' }],
    teach: 'Supine; from the umbilicus out to the flank until dull; finger stays; patient rolls away; wait ~30 s; percuss again — resonant means free fluid.' },

  { id: 'kneejerk', group: 'Neurology', name: 'Knee jerk', finding: 'kneejerk',
    pos: { ok: ['legsHanging', 'supine'], why: 'Sitting with the legs hanging free, or lying with the knee supported in slight flexion.' },
    taps: [{ view: 'knee', ask: 'Where do you strike with the hammer?', ok: ['tendon'], wrong: { patella: 'You struck the patella. Strike the PATELLAR TENDON, just below it.', quads: 'That is the thigh. Strike the patellar tendon below the patella.', tuberosity: 'Too low — that is the tibial tuberosity. Strike the tendon between the patella and the tuberosity.' } }],
    steps: [{ ask: 'If absent, you…', options: ["Repeat with reinforcement (Jendrassik's manoeuvre)", 'Record it as absent straight away', 'Strike harder on the patella'], answer: 0, why: 'Patient locks fingers and pulls as you strike.' },
      { ask: 'Root value:', options: ['L3, L4', 'S1, S2', 'C5, C6'], answer: 0, why: 'Knee jerk: L3–L4 (femoral nerve).' }],
    teach: 'Legs hanging or knee supported in slight flexion; strike the patellar tendon; reinforce if absent; L3–L4.' },

  { id: 'lymph', group: 'General', name: 'Cervical lymph nodes', finding: 'lymph',
    pos: { ok: ['sitting'] },
    steps: [{ ask: 'You examine from…', options: ['Behind the seated patient, head slightly flexed', 'In front, neck extended', 'The foot of the bed'], answer: 0, why: 'From behind, with the head slightly flexed to relax the neck.' },
      { ask: 'Go through the groups…', options: ['In a fixed order — submental, submandibular, pre- and post-auricular, occipital, cervical chains, supraclavicular', 'Wherever there is a lump', 'Only the supraclavicular'], answer: 0, why: 'A fixed sequence so no group is missed. Left supraclavicular = Virchow\'s node.' }],
    teach: 'From behind, head slightly flexed; a fixed sequence of groups; size, number, consistency, tenderness, fixity, matting.' }
];
const TECH = Object.fromEntries(TECHNIQUES.map(t => [t.id, t]));
const TECH_TERMS = {
  oedema: ['pitting oedema', 'pedal oedema', 'edema', 'medial malleolus', 'sacral oedema'], jvp: ['jugular venous pressure', 'jvp', 'internal jugular', 'sternal angle', 'hepatojugular'],
  pallor: ['pallor', 'palpebral conjunctiva', 'anaemia'], icterus: ['icterus', 'jaundice', 'sclera', 'bulbar conjunctiva'], cyanosis: ['cyanosis', 'central cyanosis', 'peripheral cyanosis', 'tongue'],
  clubbing: ['clubbing', 'schamroth', 'nail bed', 'lovibond'], pulse: ['radial pulse', 'pulse rate', 'radio-femoral', 'radio-radial', 'rhythm'], bp: ['blood pressure', 'sphygmomanometer', 'korotkoff', 'cuff', 'auscultatory gap'],
  crt: ['capillary refill', 'capillary filling'], carotid: ['carotid pulse', 'carotid'], apex: ['apex beat', 'apical impulse', 'intercostal space', 'midclavicular'], trachea: ['trachea', 'trail sign', 'suprasternal notch', 'tracheal position'],
  liver: ['liver', 'hepatomegaly', 'palpation of liver', 'right iliac fossa'], spleen: ['spleen', 'splenomegaly', 'palpation of spleen'], murphy: ['murphy', 'gallbladder', 'cholecystitis'],
  shifting: ['shifting dullness', 'ascites', 'fluid thrill'], kneejerk: ['knee jerk', 'patellar reflex', 'reflexes', 'jendrassik'], lymph: ['lymph nodes', 'cervical lymph', 'lymphadenopathy']
};

/**
 * The steps as YOUR clinical book teaches them. The drills above carry the essentials; the book
 * carries every step an examiner watches for — the torch for the JVP, the two scales, warming the
 * hands, the order things are done in. Read once per technique from the book's own pages, kept
 * with your settings so every device has it, and quoted with page numbers.
 */
const TechBook = {
  key: id => 'tech-' + id,
  async get(id) { return DB.get('prefs', this.key(id)); },
  // Read in on this device, or its text sent across from the laptop — either way its pages are here.
  async books() {
    const all = await DB.all('books');
    const remote = (typeof BookText !== 'undefined' ? BookText.remote() : []).filter(r => r.complete && !all.some(b => b.id === r.id)).map(r => ({ ...r, remote: 1 }));
    const pool = [...all, ...remote];
    const practical = pool.filter(b => b.role === 'practical');
    return practical.length ? practical : pool.filter(b => b.role === 'ref');
  },

  /** The pages of one particular book that best match a topic. */
  async pagesFor(book, topic, maxPages = 5, maxChars = 20000) {
    const terms = topicTerms(topic), top = [];
    await DB.each('pages', 'bookId', book.id, pg => { const s = scorePage(pg.text, terms); if (s > 0) top.push({ s, bookId: book.id, p: pg.p, text: pg.text, book: book.short || book.name }); });
    top.sort((a, b) => b.s - a.s);
    const out = []; let chars = 0;
    for (const x of top) { if (out.length >= maxPages || (chars + Math.min(x.text.length, 9000) > maxChars && out.length)) break; out.push(x); chars += Math.min(x.text.length, 9000); }
    return out.sort((a, b) => a.p - b.p);
  },
  async learn(id) {
    const t = TECH[id];
    const topic = { name: t.name, kw: TECH_TERMS[id] || [t.name.toLowerCase()] };
    if (!(await this.books()).length) throw new Error('No clinical-methods book on this device. In the Library, set your clinical book (e.g. Boloor) to the role "Practical / clinical methods".');
    let pages = [];
    for (const b of await this.books()) { pages = await this.pagesFor(b, topic, 4, 16000); if (pages.length) break; }
    // The book is there but does not describe this one — say so for this technique only.
    if (!pages.length) return { id: this.key(id), techId: id, found: false };
    const out = await AI.call({ temperature: 0.1, system: typeof SYSTEM_TUTOR !== 'undefined' ? SYSTEM_TUTOR : undefined, prompt: `Below are pages from the student's clinical-methods book. Write how to examine: "${t.name}", EXACTLY as THIS book teaches it.

- Every step, in the book's order, short and in the imperative: preparation (introduce, consent, position, exposure, light — e.g. a torch shone tangentially — warm hands, instruments such as scales, tape, hammer, torch), the act itself (where, which side, which hand, how long), how to read or measure it, and what is normal.
- Do not add steps the book does not describe, and do not drop any it does.
- Cite each step with the bracket label of the page it comes from, like [Boloor p.112].
- If these pages do not cover this examination, return {"found":false}.

Return JSON: {"found":true,"steps":[{"text":"","cite":""}],"equipment":[""],"normal":"","pitfalls":[""]}

PAGES:
${excerptBlock(pages)}` });
    const rec = { id: this.key(id), techId: id, found: !!out?.found && (out.steps || []).length >= 3, steps: (out?.steps || []).slice(0, 18), equipment: out?.equipment || [], normal: out?.normal || '', pitfalls: out?.pitfalls || [], book: pages[0].book, at: Date.now() };
    await DB.put('prefs', rec);
    return rec;
  }
};
window.TechBook = TechBook;

/** One technique, done on the drawing, step by step. `done(result)` is called at the end. */
const Station = {
  t: null, st: null,
  async open(id, { done, finding } = {}) {
    this.t = TECH[id];
    this.st = { stage: this.t.pos ? 'pos' : this.t.stand ? 'stand' : this.t.taps?.length ? 'tap' : 'steps', tap: 0, step: 0, checks: [], touches: [], done, finding };
    this.book = null;
    this.paint();
    try {
      this.book = await TechBook.get(id);
      // Not read from the book yet: do it now, quietly, so the next attempt has it.
      if (!this.book && AI.key && (await TechBook.books()).length) TechBook.learn(id).then(r => { if (this.t?.id === id) this.book = r; }).catch(() => {});
    } catch (e) {}
  },

  // One step of the book's sequence hidden; you pick the one that belongs there. This is what
  // catches "forgot the torch" — knowing the idea but skipping a step the examiner watches for.
  gapQuestion() {
    const b = this.book;
    if (!b?.found || (b.steps || []).length < 4) return null;
    if (this.st.gap) return this.st.gap;
    const steps = b.steps.map(x => x.text);
    const prefer = steps.map((x, i) => i).filter(i => /torch|light|scale|ruler|tape|warm|consent|expos|position|explain|wash|hammer|stethoscope|cuff|minute|second/i.test(steps[i]));
    const hide = (prefer.length ? prefer : steps.map((x, i) => i))[Math.floor(Math.random() * (prefer.length || steps.length))];
    const others = TECHNIQUES.filter(t => t.id !== this.t.id).flatMap(t => (t.steps || []).map(q => q.options[q.answer])).filter(x => x && x !== steps[hide]);
    const opts = shuffle([steps[hide], ...shuffle(others).slice(0, 3)]);
    return (this.st.gap = { steps, hide, opts, answer: opts.indexOf(steps[hide]), cite: b.steps[hide].cite });
  },
  check(ok, what, msg) { this.st.checks.push({ ok, what, msg }); },
  next() {
    const s = this.st, t = this.t;
    const order = ['pos', 'stand', 'tap', 'steps', 'gap', 'result'];
    if (s.stage === 'tap' && s.tap < (t.taps?.length || 0) - 1) { s.tap++; return this.paint(); }
    if (s.stage === 'steps' && s.step < (t.steps?.length || 0) - 1) { s.step++; return this.paint(); }
    let i = order.indexOf(s.stage) + 1;
    while (order[i] === 'stand' && !t.stand || order[i] === 'tap' && !t.taps?.length || order[i] === 'steps' && !t.steps?.length || order[i] === 'gap' && !this.gapQuestion()) i++;
    s.stage = order[i];
    if (s.stage === 'result') this.finish();
    this.paint();
  },
  finish() {
    const s = this.st, t = this.t;
    const taps = s.checks.filter(c => c.what === 'tap');
    s.passed = s.checks.every(c => c.ok);
    s.techniqueOk = taps.every(c => c.ok);   // the finding is only yours if the hands did it right
    s.score = Math.round(100 * s.checks.filter(c => c.ok).length / Math.max(1, s.checks.length));
    try {
      const log = JSON.parse(localStorage.getItem('drillLog') || '{}');
      const e = log[t.id] ||= { n: 0, ok: 0, last: 0, misses: [] };
      e.n++; if (s.passed) e.ok++; e.last = Date.now();
      e.misses = [...s.checks.filter(c => !c.ok).map(c => c.msg), ...e.misses].slice(0, 6);
      localStorage.setItem('drillLog', JSON.stringify(log));
    } catch (e) {}
    s.done?.(s);
  },

  svg(view, extra = '') {
    const v = BODY[view];
    return `<svg class="body-svg" viewBox="0 0 300 300" data-view="${view}">${v.svg}${extra}
      ${v.sides ? `<text class="side" x="8" y="14">Patient's R</text><text class="side" x="292" y="14" text-anchor="end">Patient's L</text>` : ''}</svg>`;
  },

  paint() {
    const host = document.getElementById('station');
    if (!host) return;
    const s = this.st, t = this.t;
    const head = `<div class="row between mid"><h3>${esc(t.name)}</h3><button class="btn ghost sm" data-act="stClose">Close</button></div>`;
    if (s.stage === 'pos') {
      host.innerHTML = `${head}<p class="st-ask">How is the patient positioned?</p>
        <div class="chips">${Object.entries(POSITIONS).map(([k, l]) => `<button class="chip lg" data-act="stPos" data-v="${k}">${l}</button>`).join('')}</div>`;
    } else if (s.stage === 'stand') {
      host.innerHTML = `${head}<p class="st-ask">Where do you stand?</p>
        <div class="chips"><button class="chip lg" data-act="stStand" data-v="right">On the patient's right</button><button class="chip lg" data-act="stStand" data-v="left">On the patient's left</button></div>`;
    } else if (s.stage === 'tap') {
      const tp = t.taps[s.tap];
      host.innerHTML = `${head}<p class="st-ask">${esc(tp.ask)}</p>
        <div class="st-body" id="st-body">${this.svg(tp.view)}<div class="st-hold" id="st-hold" hidden></div></div>
        <p class="muted small center">${BODY[tp.view].title}${tp.hold ? ' · press and hold' : ' · tap the spot'}</p>`;
      this.wire(tp);
    } else if (s.stage === 'steps') {
      const q = t.steps[s.step];
      const order = shuffle(q.options.map((o, i) => i));
      host.innerHTML = `${head}<p class="st-ask">${esc(q.ask)}</p>
        <div class="menu">${order.map(i => `<button class="btn full" data-act="stStep" data-i="${i}">${esc(q.options[i])}</button>`).join('')}</div>`;
    } else if (s.stage === 'gap') {
      const g = this.gapQuestion();
      host.innerHTML = `${head}<p class="st-ask">Your book's steps — which one is missing?</p>
        <ol class="gap-steps">${g.steps.map((x, i) => `<li class="${i === g.hide ? 'gap' : ''}">${i === g.hide ? '<b>?</b>' : esc(x)}</li>`).join('')}</ol>
        <div class="menu">${g.opts.map((o, i) => `<button class="btn full" data-act="stGap" data-i="${i}">${esc(o)}</button>`).join('')}</div>
        <p class="muted small">From ${esc(this.book.book || 'your clinical book')}.</p>`;
    } else if (s.stage === 'result') {
      const shown = (t.taps || []).map((tp, i) => {
        const touch = s.touches[i];
        const good = tp.ok.map(id => BODY[tp.view].marks[id]).map(m => `<circle class="mk-ok" cx="${m.x}" cy="${m.y}" r="${m.r}"/>`).join('');
        const mine = touch ? `<circle class="mk-me ${s.checks.find(c => c.what === 'tap' && c.i === i)?.ok ? 'ok' : 'bad'}" cx="${touch.x}" cy="${touch.y}" r="6"/>` : '';
        return `<div class="st-mini">${this.svg(tp.view, good + mine)}</div>`;
      }).join('');
      host.innerHTML = `${head}
        <div class="st-score ${s.passed ? 'ok' : 'bad'}">${s.passed ? 'Done correctly' : 'Not quite'} · ${s.score}%</div>
        <ul class="st-checks">${s.checks.map(c => `<li class="${c.ok ? 'ok' : 'bad'}">${esc(c.msg)}</li>`).join('')}</ul>
        ${shown ? `<div class="st-minis">${shown}</div><p class="muted small center">Green: where it is done. Your touch: the dot.</p>` : ''}
        ${s.finding != null ? `<div class="callout mt"><b>Finding</b><p>${s.techniqueOk ? esc(s.finding || 'Normal.') : 'Not elicited — the technique was not right, so there is no reliable finding. The examiner noticed.'}</p></div>` : ''}
        <p class="muted small mt">${esc(t.teach)}</p>
        ${this.book?.found ? `<details class="book-steps mt" open><summary><b>As ${esc(this.book.book || 'your book')} teaches it</b></summary>
          <ol>${this.book.steps.map(x => `<li>${esc(x.text)} <span class="muted small">${esc(x.cite || '')}</span></li>`).join('')}</ol>
          ${this.book.normal ? `<p class="small"><b>Normal:</b> ${esc(this.book.normal)}</p>` : ''}
          ${this.book.pitfalls?.length ? `<p class="small"><b>Common mistakes:</b> ${esc(this.book.pitfalls.join(' · '))}</p>` : ''}</details>` : ''}
        <div class="row gap mt"><button class="btn" data-act="stAgain">Do it again</button><button class="btn primary" data-act="stClose">Done</button></div>`;
    }
  },

  wire(tp) {
    const box = document.getElementById('st-body'), svg = box?.querySelector('svg'), hold = document.getElementById('st-hold');
    if (!svg) return;
    let t0 = 0, pt = null, timer = null;
    const toSvg = e => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
    const down = e => {
      e.preventDefault();
      pt = toSvg(e); t0 = Date.now();
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y); dot.setAttribute('r', 7); dot.setAttribute('class', 'mk-press');
      svg.appendChild(dot);
      if (tp.hold) {
        hold.hidden = false;
        timer = setInterval(() => { hold.textContent = ((Date.now() - t0) / 1000).toFixed(0) + ' s'; }, 200);
      }
    };
    const up = e => {
      if (!pt) return;
      clearInterval(timer);
      const secs = (Date.now() - t0) / 1000;
      if (!tp.hold && secs > 0) {/* a tap */}
      this.touched(tp, pt, secs);
      pt = null;
    };
    svg.addEventListener('pointerdown', down);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointerleave', up);
    svg.addEventListener('pointercancel', up);
  },

  // Which landmark a touch landed on: the nearest one it falls inside.
  hit(view, p) {
    let best = null, bd = Infinity;
    for (const [id, m] of Object.entries(BODY[view].marks)) {
      const d = Math.hypot(m.x - p.x, m.y - p.y);
      if (d <= m.r && d < bd) { bd = d; best = id; }
    }
    return best;
  },

  touched(tp, p, secs) {
    const s = this.st, i = s.tap, id = this.hit(tp.view, p), marks = BODY[tp.view].marks;
    s.touches[i] = { x: p.x, y: p.y };
    const where = id ? marks[id].label : 'a spot with nothing there';
    const right = tp.ok.map(x => marks[x].label);
    if (tp.ok.includes(id)) this.check(true, 'tap', `Right place: ${where}.`);
    else if (tp.also?.[id]) this.check(true, 'tap', tp.also[id]);
    else if (tp.wrong?.[id]) this.check(false, 'tap', tp.wrong[id]);
    else this.check(false, 'tap', `You touched ${where}. This is done at the ${right[0]}.`);
    s.checks[s.checks.length - 1].i = i;
    if (tp.hold) {
      const [lo, hi] = tp.hold;
      if (secs < lo) this.check(false, 'hold', `Held for ${Math.round(secs)} s — too short. ${tp.holdWhy}`);
      else if (secs > hi * 2.5) this.check(false, 'hold', `Held for ${Math.round(secs)} s — far longer than needed. ${tp.holdWhy}`);
      else this.check(true, 'hold', `Held for ${Math.round(secs)} s — good.`);
    }
    setTimeout(() => this.next(), 350);
  }
};
window.Station = Station; window.TECHNIQUES = TECHNIQUES; window.TECH = TECH; window.BODY = BODY;

Object.assign(A, {
  stPos(el) {
    const t = Station.t, v = el.dataset.v;
    const ok = t.pos.ok.includes(v);
    Station.check(ok, 'pos', ok ? `Position: ${POSITIONS[v]} — right.` : `Position: ${POSITIONS[v]} — wrong. ${t.pos.ok.map(k => POSITIONS[k]).join(' or ')}.${t.pos.why ? ' ' + t.pos.why : ''}`);
    Station.next();
  },
  stStand(el) {
    const ok = el.dataset.v === Station.t.stand;
    Station.check(ok, 'stand', ok ? 'Standing on the patient\'s right — right.' : 'Stand on the PATIENT\'S RIGHT side — the convention for examination, and how examiners expect to see it.');
    Station.next();
  },
  stStep(el) {
    const q = Station.t.steps[Station.st.step], ok = +el.dataset.i === q.answer;
    Station.check(ok, 'step', ok ? q.why : `${q.ask} ${q.options[q.answer]}. ${q.why}`);
    Station.next();
  },
  stGap(el) {
    const g = Station.gapQuestion(), ok = +el.dataset.i === g.answer;
    Station.check(ok, 'gap', ok ? `Right — the missing step was: ${g.steps[g.hide]}.` : `The missing step was: ${g.steps[g.hide]} ${g.cite || ''}. You chose: ${g.opts[+el.dataset.i]}.`);
    Station.next();
  },
  stAgain() { Station.open(Station.t.id, { done: Station.st.done, finding: Station.st.finding }); },
  stClose() { const h = document.getElementById('station'); if (h) { h.innerHTML = ''; h.hidden = true; } document.body.classList.remove('station-open'); App.render(true); }
});

function openStation(id, opts) {
  const h = document.getElementById('station');
  if (!h) return;
  h.hidden = false;
  document.body.classList.add('station-open');
  Station.open(id, opts);
}

// ---------- examination drills: the techniques on their own ----------

Views.drills = async () => {
  let log = {}; try { log = JSON.parse(localStorage.getItem('drillLog') || '{}'); } catch (e) {}
  const groups = {};
  TECHNIQUES.forEach(t => (groups[t.group] ||= []).push(t));
  const weak = TECHNIQUES.filter(t => log[t.id] && log[t.id].ok < log[t.id].n);
  return `<div class="page"><header class="page-head"><div><p class="eyebrow"><a class="link" href="#/practice">Practice</a></p><h1>Examination drills</h1></div>
      <button class="btn primary" data-act="drillWeak" ${weak.length ? '' : 'disabled'}>Drill my mistakes${weak.length ? ` (${weak.length})` : ''}</button></header>
    <p class="muted">Where to stand, how the patient lies, the exact spot and side, how long to press. The patient faces you — their right is on your left.</p>
    ${await (async () => {
      const learned = (await Promise.all(TECHNIQUES.map(t => TechBook.get(t.id)))).filter(r => r?.found).length;
      const books = await TechBook.books();
      if (!books.length) return `<p class="muted small">Tip: set your clinical-methods book (e.g. Boloor) to the role "Practical" in the Library, and every drill will also follow its steps.</p>`;
      return `<div class="card soft mt row between mid wrap gap"><span class="small">${learned} of ${TECHNIQUES.length} techniques follow <b>${esc(books[0].short || books[0].name)}</b> step by step.</span>
        ${learned < TECHNIQUES.length ? `<button class="btn sm" data-act="drillLearn">Read the rest from the book</button>` : `<button class="btn ghost sm" data-act="drillLearn" data-all="1">Read again</button>`}</div>`;
    })()}
    ${Object.entries(groups).map(([g, ts]) => `<section class="card flush mt"><div class="card-head pad"><h3>${esc(g)}</h3></div><div class="list">
      ${ts.map(t => { const e = log[t.id]; return `<button class="row between pad drill-row" data-act="drillGo" data-id="${t.id}"><span><b>${esc(t.name)}</b>${e?.misses?.[0] && e.ok < e.n ? `<br><small class="warn-t">Last time: ${esc(e.misses[0].slice(0, 90))}</small>` : ''}</span><span class="small ${e ? (e.ok === e.n ? 'ok-t' : 'warn-t') : 'muted'}">${e ? `${e.ok}/${e.n}` : 'not tried'}</span></button>`; }).join('')}
    </div></section>`).join('')}
    <div id="station" class="station" hidden></div></div>`;
};

Object.assign(A, {
  drillGo(el) { openStation(el.dataset.id, {}); },
  async drillLearn(el) {
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; el.disabled = true;
    let n = 0, fail = '';
    for (const t of TECHNIQUES) {
      if (!el.dataset.all && (await TechBook.get(t.id))?.found) continue;
      el.innerHTML = `<span class="spin"></span>${esc(t.name)}…`;
      try { const r = await TechBook.learn(t.id); if (r.found) n++; } catch (e) { fail = e.message || String(e); if (/No clinical-methods book|Gemini API key/.test(fail)) break; }
    }
    toast(fail && !n ? fail : `${n} technique${n === 1 ? '' : 's'} now follow your book.${fail ? ' Some could not be read: ' + fail : ''}`, 9000);
    App.render(true);
  },
  drillWeak() {
    let log = {}; try { log = JSON.parse(localStorage.getItem('drillLog') || '{}'); } catch (e) {}
    const weak = TECHNIQUES.filter(t => log[t.id] && log[t.id].ok < log[t.id].n).sort((a, b) => (log[a.id].last || 0) - (log[b.id].last || 0));
    if (weak[0]) openStation(weak[0].id, {});
  }
});

ROUTES.push([/^#\/drills$/, () => Views.drills()]);
// Leaving the page with a technique open must not leave the page unscrollable.
window.addEventListener('hashchange', () => document.body.classList.remove('station-open'));
