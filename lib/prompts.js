const fs = require('fs');
const path = require('path');

let styleBibleCache;
let threadDnaCache;
const OUTLINE_FORMATS = new Set(['quote', 'listicle', 'detective', 'profile', 'news', 'learning']);
const THREAD_INTENSITIES = new Set(['calm', 'standard', 'spicy']);

function loadStyleBible() {
  if (styleBibleCache !== undefined) {
    return styleBibleCache;
  }

  try {
    styleBibleCache = fs.readFileSync(path.join(__dirname, '..', 'style', 'bible.md'), 'utf8');
  } catch (error) {
    styleBibleCache = '';
  }

  return styleBibleCache;
}

function loadThreadDna() {
  if (threadDnaCache !== undefined) {
    return threadDnaCache;
  }

  try {
    threadDnaCache = fs.readFileSync(path.join(__dirname, '..', 'style', 'threads-dna.md'), 'utf8');
  } catch (error) {
    threadDnaCache = '';
  }

  return threadDnaCache;
}

const THREAD_INTENSITY_NOTE = {
  calm: '강도=차분: 어그로를 최소화하고 분석 비중을 높여라. 훅도 절제하되 완독 약속 한 줄은 유지.',
  standard: '강도=표준: DNA의 4단 훅 공식과 열린 고리 사슬을 그대로 적용.',
  spicy: '강도=센캐: 훅·손실 위협·진영/세대 자극을 최대로. 단, 사실·수치·인용은 절대 왜곡하지 마라.',
};

function normalizeThreadIntensity(value) {
  return THREAD_INTENSITIES.has(value) ? value : 'standard';
}

function buildThreadPrompt({ topic = '', source = '', sourceUrl = '', count = null, intensity = 'standard' } = {}) {
  const dna = loadThreadDna();
  const hasCount = Number.isFinite(Number(count)) && Number(count) > 0;
  const safeCount = hasCount ? Math.max(4, Math.min(20, Number(count))) : null;
  const countNote = safeCount
    ? `- 본문 포스트(body)는 정확히 ${safeCount}개.`
    : `- 본문 포스트(body) 수는 내용에 맞게 네가 직접 정하라(대략 5~14편 범위). 핵심 논점 하나당 한 편 — 분량 채우려 억지로 늘리지 말고, 중요한 걸 빼며 줄이지도 마라. 소재가 얇으면 짧게, 두꺼우면 길게.`;
  const note = THREAD_INTENSITY_NOTE[normalizeThreadIntensity(intensity)];
  const closingNote = "- closing: 본문 흐름에 맞춰 독자가 다음 스레드를 보게 만드는 한 줄. 되도록 열린 고리를 남기는 질문(물음표)으로 끝내라 — 다 설명하지 말고 '그래서 다음엔?' 같은 궁금증/FOMO를 남겨라. 단 억지 질문 금지: 그 글이 정말 결론형이면 여운 있는 단정도 허용. 어떤 톤(FOMO·떡밥·도발)이 이 글에 맞는지는 문맥 보고 판단.";
  const sourceBlock = String(source || '').trim()
    ? `## 소재 본문 (사실·수치·인용은 반드시 여기서만 — 없는 건 지어내지 말 것)\n${String(source).slice(0, 12000)}`
    : '## 소재 본문\n(없음 — 아래 주제를 바탕으로, 일반적으로 알려진 사실 범위에서만 작성. 불확실하면 완충 표현 사용)';
  const urlLine = String(sourceUrl || '').trim() ? `원본 링크: ${String(sourceUrl).trim()}\n` : '';

  return `당신은 Threads(스레드) 바이럴 롱폼 작가입니다.
아래 "스레드 DNA"의 후킹·화법·전개·체류 설계를 그대로 적용해, 한국어 스레드 체인을 작성하세요.

${dna || '(DNA 없음 — 뉴스 앵커 톤의 단문, 번호 매긴 사슬형 전개로 작성)'}

---

## 작성 대상
주제: ${topic || '(소재 본문에서 핵심 주제를 직접 추출)'}
${urlLine}
${sourceBlock}

## 이번 작성 지시
- ${note}
- ⚡가독성 철칙(5.5)을 강도보다 우선: 포스트당 핵심 숫자 2~3개 상한, 숫자 3개 이상 연속 나열 금지, 모든 숫자는 비교·비유로 번역, 소수점/끝자리 버림, 포스트마다 숫자 아닌 '그래서 뭐?' 한 줄.
- ⚡일반인 썸스톱 철칙(5.6) 필수: 리드 첫 줄에 고유명사·전문용어 0개(일상 충격·장면으로 시작)하되, 주제 핵심 고유명사(예: 모델명)는 리드 2~3번째 줄에 반드시 명시해 무슨 글인지 못박아라(낚시 금지). '이게 너랑 무슨 상관'을 리드~1편에 배치. AI/업계를 1도 모르는 사람이 리드만 보고 주제를 알고 다음을 누르고 싶게.
${countNote}
- lead(리드 훅)는 DNA의 4단 적층 공식으로. 정보를 주지 말고 "안 읽으면 손해"만 심고 마지막 줄에 🧵.
- ⚠️오리지널리티: 기법만 쓰고 특정 작성자의 시그니처 문구·말투를 베끼지 마라. "세상을 보는 시선/권력 구조가 다르게 보일 겁니다" 같은 상투구 금지, 매번 그 글만의 새 표현으로.
- 각 body 포스트는 "N/ "로 시작하는 text 1개. 한 포스트=한 논점. 짧은 단문을 줄바꿈(\\n)으로 끊어 쌓기.
- 포스트 사이를 인과 접속구로 연결해 열린 고리를 만들고, 미시→거시→독자의 삶으로 줌아웃.
- 강조는 < >·** 같은 기호 일절 쓰지 마라(AI 티). 강조하고 싶으면 어순·짧은 단문·줄바꿈으로. 인용만 따옴표.
- imageHint: 리드에 붙일 도발적 상징 이미지 아이디어 1줄(한국어).
${closingNote}
- 사실·수치·발언은 소재에 있는 것만. 없으면 일반화로 톤만 유지하고 단정하지 말 것.

## 출력 형식 (JSON만 출력, 다른 텍스트·마크다운 금지)
{
  "lead": "리드 훅 3~5줄\\n줄바꿈은 \\\\n으로\\n마지막 줄 🧵",
  "imageHint": "리드에 붙일 상징 이미지 한 줄",
  "posts": [
    { "n": 1, "text": "1/ 첫 논점 본문..." },
    { "n": 2, "text": "2/ 다음 논점 본문..." }
  ],
  "closing": "( 이 글을 클릭하면 글이 더 나옵니다 )"
}`;
}

function buildWritePrompt({
  title,
  body,
  inputType,
  tone,
  sources = [],
  imageCandidates = [],
  items = [],
  outline = null,
  styleBible,
  angle = null,
  sourceNames = [],
  format = null,
  direction = null,
}) {
  const sourceContext = sources.length > 0
    ? `\n참고 소스 레지스트리:\n${sources.map((source) => `- ${source.name} (${source.domain}) [${(source.tags || []).join(',')}]`).join('\n')}`
    : '';
  const toneInstruction = tone?.promptSuffix || '';
  const imageInfo = imageCandidates.length > 0
    ? `\n사용 가능한 이미지: ${imageCandidates.length}장 (photo 필드에 0부터 인덱스로 지정)\n${imageCandidates
        .map((candidate, index) => {
          const dims = candidate && candidate.width && candidate.height ? ` ${candidate.width}x${candidate.height}` : '';
          const label = candidate && candidate.label ? ` ${candidate.label}` : '';
          return `  [${index}]${dims}${label}`.replace(/\s+$/, '');
        })
        .join('\n')}\n→ 슬라이드마다 서로 다른 photo 인덱스를 쓰세요. 같은 사진을 반복하지 말 것(이미지 수가 슬라이드보다 적을 때만 일부 재사용).`
    : '';
  const styleBibleText = typeof styleBible === 'string' ? styleBible : loadStyleBible();
  const angleContext = angle && (angle.title || angle.hook || angle.tone)
    ? `\n선택된 앵글:\n- 제목: ${angle.title || '(없음)'}\n- 훅: ${angle.hook || '(없음)'}\n- 톤: ${angle.tone || '(지정 없음)'}`
    : '';
  const directionContext = direction && String(direction).trim()
    ? `\n## 🧭 에디터 방향 지시 (최우선 반영)\n${String(direction).trim()}\n위 지시가 앵글·아웃라인과 충돌하면 이 지시를 따르되, 근거 인벤토리에 없는 사실을 지어내면 안 됩니다.`
    : '';
  const itemContext = items.length > 0
    ? `\n근거 인벤토리:\n${formatItemsForPrompt(items)}`
    : '';
  const resolvedSourceNames = resolveSourceNames({ sourceNames, outline, items, sources });
  const sourceLine = resolvedSourceNames.length ? resolvedSourceNames.join(', ') : '없음';
  const outlineContext = hasOutlineContext(outline, format)
    ? `\n아웃라인:\n${formatOutlineForPrompt(outline, format)}`
    : '';
  const outlineInstruction = Array.isArray(outline) && outline.length > 0
    ? `\n4. 아래 아웃라인의 슬라이드 순서·메시지·근거(itemRefs)를 그대로 따라 카피를 작성하세요. 근거에 없는 수치·고유명사·주장 추가를 금지합니다.
5. 각 슬라이드는 해당 outline.message 하나만 전달해야 합니다. 메시지 2개를 한 장에 욱여넣지 마세요.
6. itemRefs가 비어 있으면 단정형을 피하고 완충 표현만 사용하세요.`
    : '';

  return `당신은 인스타그램 매거진 캐러셀 에디터입니다.
아래 소재를 바탕으로 캐러셀 포스트를 구성하세요.

## 스타일 바이블
${styleBibleText || '(없음)'}

## 소재
제목: ${title || '(없음)'}
본문:
${body || '(주제 기반 생성)'}
입력 타입: ${inputType}
${sourceContext}
${imageInfo}${angleContext}${directionContext}${outlineContext}${itemContext}

## 지시사항
1. postType을 결정하세요:
   - "brief": 뉴스 브리프 (3장: cover + body 1~2장). 짧은 팩트 전달.
   - "essay": 에세이/스토리 (6~10장: cover + body 4~8장 + ending). 깊은 분석/서사.
   판단 기준: 본문 길이 300자 미만이거나 단순 뉴스면 brief, 그 외 essay.

2. 각 슬라이드의 텍스트를 작성하세요.

3. 캡션(인스타 본문)과 해시태그를 작성하세요. 캡션 마지막 줄은 반드시 정확히 "출처: ${sourceLine}"로 끝내세요. hashtags는 반드시 빈 문자열("")로 두세요.${outlineInstruction}

${toneInstruction}

## 슬라이드 텍스트 제한 (반드시 준수)
- cover: headline 줄당 12자 이내, 최대 2줄. kicker 20자 이내 1줄.
- body: subtitle은 반드시 한 줄 — \\n 금지(렌더러가 폭에 맞춰 크기 조절). 번호 전개면 "1. " prefix 사용.
- body paragraphs: 완결 문장으로 자연스럽게 쓰고 \\n을 넣지 마세요(렌더러가 자동 줄바꿈). 단락당 1~3문장, 단락 최대 3개. 마지막 단락은 _밑줄_ 펀치라인 1문장.
- ending: headline 줄당 16자 이내, 최대 2줄.
- 하이라이트 마크업: [단어] (슬라이드당 1~2개만). 밑줄: _문장_ (줄 앞뒤에 _)
- \\n으로 줄바꿈 명시.

## 출력 형식 (JSON만 출력, 다른 텍스트 금지)
{
  "postType": "brief|essay",
  "slides": [
    {
      "type": "cover",
      "headline": "헤드라인\\n두번째줄",
      "kicker": "키커 텍스트|null",
      "photo": 0
    },
    {
      "type": "body",
      "subtitle": "한 줄 소제목입니다",
      "paragraphs": ["완결 문장으로 쓴 단락입니다. 렌더러가 알아서 줄을 바꿉니다.", "[키워드] 강조가 든 문장.", "_마지막 펀치라인 한 문장._"],
      "photo": 1
    },
    {
      "type": "ending",
      "headline": "마무리\\n문구",
      "photo": null
    }
  ],
  "caption": "인스타 캡션 전문\\n\\n출처: ${sourceLine}",
  "hashtags": ""
}`;
}

function buildAnglesPrompt({
  title,
  summary,
  items = [],
  body,
  hints = [],
  negativeTitles = [],
}) {
  const styleBibleText = loadStyleBible();
  const hintText = Array.isArray(hints) && hints.length
    ? hints.map((hint) => `- ${hint}`).join('\n')
    : '(없음)';
  const negativeTitleText = Array.isArray(negativeTitles) && negativeTitles.length
    ? negativeTitles.map((negativeTitle) => `- ${negativeTitle}`).join('\n')
    : '(없음)';

  return `당신은 인스타그램 매거진 캐러셀 기획자입니다.
같은 인벤토리로 서로 다른 이야기 각도의 앵글 후보를 정확히 3개만 제안하세요.

## 스타일 바이블
${styleBibleText || '(없음)'}

## 소재
제목: ${title || '(없음)'}
요약: ${summary || '(없음)'}
본문:
${body || '(없음)'}

## 인벤토리
${formatItemsForPrompt(items)}

## 추가 힌트
${hintText}

## 제외할 이전 앵글 제목
${negativeTitleText}

## 규칙
1. angles는 정확히 3개만 작성하세요. 2개나 4개 금지.
2. 세 앵글은 서로 다른 주제축·감정선·독자 효용을 가져야 합니다.
3. title은 기사 제목 복붙이 아니라 재해석된 포스트 제목이어야 합니다.
4. hook은 독자를 후킹하는 1줄입니다.
5. tone은 반드시 "fact" 또는 "emotional" 또는 "behind" 중 하나입니다.
6. postType은 반드시 "brief" 또는 "essay" 중 하나입니다.
7. slideEstimate는 structure 길이와 같아야 합니다.
8. structure는 role 배열이며 값은 "cover", "context", "body", "insight", "ending"만 사용하세요.
9. brief는 정확히 3개 역할, essay는 6~10개 역할로 스타일 바이블 구조를 따르세요.
10. itemRefs는 반드시 인벤토리에 있는 ref만 사용하세요.
11. estimateCount는 itemRefs에 포함한 항목 중 origin.confidence가 0.7 미만인 개수입니다.
12. negativeTitles와 같은 제목·주제축은 피하세요.

## 출력 형식 (JSON만 출력, 다른 텍스트 금지)
{
  "angles": [
    {
      "title": "앵글 제목",
      "hook": "독자 후킹 1줄",
      "tone": "fact|emotional|behind",
      "postType": "brief|essay",
      "slideEstimate": 7,
      "structure": ["cover", "context", "body", "body", "body", "insight", "ending"],
      "itemRefs": ["i1", "i3"],
      "estimateCount": 1
    },
    {
      "title": "앵글 제목",
      "hook": "독자 후킹 1줄",
      "tone": "fact|emotional|behind",
      "postType": "brief|essay",
      "slideEstimate": 6,
      "structure": ["cover", "context", "body", "body", "insight", "ending"],
      "itemRefs": ["i2", "i4"],
      "estimateCount": 0
    },
    {
      "title": "앵글 제목",
      "hook": "독자 후킹 1줄",
      "tone": "fact|emotional|behind",
      "postType": "brief|essay",
      "slideEstimate": 3,
      "structure": ["cover", "body", "ending"],
      "itemRefs": ["i1"],
      "estimateCount": 0
    }
  ]
}`;
}

function buildOutlinePrompt({ angle, items = [], body, title, segments = [], direction = null }) {
  const styleBibleText = loadStyleBible();
  const directionBlock = direction && String(direction).trim()
    ? `\n## 🧭 에디터 방향 지시 (최우선 반영)\n${String(direction).trim()}\n앵글과 충돌하면 이 지시를 따르되, 인벤토리에 없는 사실은 추가하지 마세요.\n`
    : '';
  const anglePostType = angle?.postType || '(지정 없음)';
  const angleStructure = Array.isArray(angle?.structure) && angle.structure.length
    ? angle.structure.join(', ')
    : '(지정 없음)';
  const segmentContext = buildOutlineSegmentContext(segments);

  if (!segmentContext) {
    return `당신은 인스타그램 매거진 캐러셀 아웃라인 설계자입니다.
선택된 앵글과 근거 인벤토리를 바탕으로 슬라이드 아웃라인을 설계하세요.

## 스타일 바이블
${styleBibleText || '(없음)'}

## 소재
제목: ${title || '(없음)'}
본문:
${body || '(없음)'}

${directionBlock}
## 선택된 앵글
제목: ${angle?.title || '(없음)'}
훅: ${angle?.hook || '(없음)'}
톤: ${angle?.tone || '(지정 없음)'}
postType: ${anglePostType}
structure: ${angleStructure}

## 인벤토리
${formatItemsForPrompt(items)}

## 규칙
1. style bible의 구조 문법을 우선 적용하세요.
2. angle.postType과 angle.structure가 주어졌다면 이를 우선 반영하되, style bible 문법을 어기면 안 됩니다.
3. 최상위 format은 반드시 "quote" | "listicle" | "detective" | "profile" | "news" | "learning" 중 하나로 채우세요. 소재와 앵글 톤에 가장 맞는 포맷을 고르고, 그 포맷의 전개를 outline 전체에 따르세요.
4. outline의 각 슬라이드는 메시지 1개만 가져야 합니다.
5. outline[].slideIndex는 0부터 순서대로 채우세요.
6. outline[].type은 반드시 "cover" | "body" | "ending" 중 하나만 사용하세요.
7. outline[].role은 반드시 "cover" | "context" | "body" | "insight" | "ending" 중 하나만 사용하세요.
8. role이 cover면 type은 cover, role이 ending이면 type은 ending, 나머지 role은 type body로 매핑하세요.
9. outline[].itemRefs에는 인벤토리에 있는 ref만 넣으세요.
10. origin.confidence가 0.7 미만인 항목은 outline에 배정하지 마세요. 완충 표현이 필요하면 message에서만 처리하고 itemRefs는 비워 두세요.
11. sourceNames는 itemRefs에 실제로 배정된 고신뢰 근거의 origin.name만 중복 없이 담으세요.
12. brief는 3장, essay는 6~10장 범위에서만 설계하세요.

## 출력 형식 (JSON만 출력, 다른 텍스트 금지)
{
  "format": "quote|listicle|detective|profile|news|learning",
  "postType": "brief|essay",
  "outline": [
    {
      "slideIndex": 0,
      "type": "cover",
      "role": "cover",
      "message": "이 슬라이드가 전달할 메시지 1개",
      "itemRefs": ["i2"]
    },
    {
      "slideIndex": 1,
      "type": "body",
      "role": "context",
      "message": "이 이슈가 왜 지금 중요한지 설명",
      "itemRefs": ["i1"]
    },
    {
      "slideIndex": 2,
      "type": "ending",
      "role": "ending",
      "message": "마지막에 남길 한 줄",
      "itemRefs": []
    }
  ],
  "sourceNames": ["CNBC", "SEC S-1"]
}`;
  }

  return `당신은 인스타그램 매거진 캐러셀 아웃라인 설계자입니다.
선택된 앵글과 근거 인벤토리를 바탕으로 슬라이드 아웃라인을 설계하세요.

## 스타일 바이블
${styleBibleText || '(없음)'}

## 소재
제목: ${title || '(없음)'}
본문:
${body || '(없음)'}

${directionBlock}
## 선택된 앵글
제목: ${angle?.title || '(없음)'}
훅: ${angle?.hook || '(없음)'}
톤: ${angle?.tone || '(지정 없음)'}
postType: ${anglePostType}
structure: ${angleStructure}
${segmentContext}

## 인벤토리
${formatItemsForPrompt(items)}

## 규칙
1. style bible의 구조 문법을 우선 적용하세요.
2. angle.postType과 angle.structure가 주어졌다면 이를 우선 반영하되, style bible 문법을 어기면 안 됩니다.
3. 최상위 format은 반드시 "quote" | "listicle" | "detective" | "profile" | "news" | "learning" 중 하나로 채우세요. 소재와 앵글 톤에 가장 맞는 포맷을 고르고, 그 포맷의 전개를 outline 전체에 따르세요.
4. outline의 각 슬라이드는 메시지 1개만 가져야 합니다.
5. outline[].slideIndex는 0부터 순서대로 채우세요.
6. outline[].type은 반드시 "cover" | "body" | "ending" 중 하나만 사용하세요.
7. outline[].role은 반드시 "cover" | "context" | "body" | "insight" | "ending" 중 하나만 사용하세요.
8. role이 cover면 type은 cover, role이 ending이면 type은 ending, 나머지 role은 type body로 매핑하세요.
9. outline[].itemRefs에는 인벤토리에 있는 ref만 넣으세요.
10. origin.confidence가 0.7 미만인 항목은 outline에 배정하지 마세요. 완충 표현이 필요하면 message에서만 처리하고 itemRefs는 비워 두세요.
11. sourceNames는 itemRefs에 실제로 배정된 고신뢰 근거의 origin.name만 중복 없이 담으세요.
12. brief는 3장, essay는 6~10장 범위에서만 설계하세요.
13. 자막이 제공되면 각 outline 항목에 "frameTs": <number>를 넣으세요. 이 값은 그 슬라이드의 message를 영상에서 실제로 말하는 순간의 초(second)입니다.
14. frameTs는 itemRefs와 message에 맞는 문맥의 타임스탬프여야 하며, cover와 ending을 포함해 모든 슬라이드에 가능한 한 채우세요. ending은 영상의 마무리/결론 장면(후반부)에서 고르세요.
15. frameTs들은 영상 전체에 분산시키세요. 슬라이드들의 frameTs가 같은 구간(±60초)에 몰리면 사실상 같은 화면이 반복 노출됩니다 — 각 메시지가 처음 언급되는 가장 이른 시점을 우선하고, 인접 슬라이드와 최소 60초 이상 간격을 두세요.

## 출력 형식 (JSON만 출력, 다른 텍스트 금지)
{
  "format": "quote|listicle|detective|profile|news|learning",
  "postType": "brief|essay",
  "outline": [
    {
      "slideIndex": 0,
      "type": "cover",
      "role": "cover",
      "message": "이 슬라이드가 전달할 메시지 1개",
      "itemRefs": ["i2"],
      "frameTs": 18
    },
    {
      "slideIndex": 1,
      "type": "body",
      "role": "context",
      "message": "이 이슈가 왜 지금 중요한지 설명",
      "itemRefs": ["i1"],
      "frameTs": 42
    },
    {
      "slideIndex": 2,
      "type": "ending",
      "role": "ending",
      "message": "마지막에 남길 한 줄",
      "itemRefs": []
    }
  ],
  "sourceNames": ["CNBC", "SEC S-1"]
}`;
}

function buildVerifyPrompt({ slides = [], items = [], outline = [], format = null }) {
  const styleBibleText = loadStyleBible();

  return `당신은 인스타그램 매거진 캐러셀 검수자입니다.
슬라이드 텍스트를 근거 인벤토리와 아웃라인에 대조해 검수하세요.

## 스타일 바이블
${styleBibleText || '(없음)'}

## 근거 인벤토리
${formatItemsForPrompt(items)}

## 아웃라인
${hasOutlineContext(outline, format) ? formatOutlineForPrompt(outline, format) : '(없음)'}

## 슬라이드
${formatSlidesForPrompt(slides)}

## 체크 기준
1. 각 슬라이드는 outline에서 같은 slideIndex의 itemRefs만 근거로 사용할 수 있습니다. 그 근거에 없는 수치·고유명사·주장이 들어갔는지 확인하세요.
2. 근거와 모순되는 표현이 있는지 확인하세요.
3. 글자 수 제한(줄당 자수·줄수·단락 수의 명시 한도)을 어겼는지 확인하세요. 단, 한도 이내라면 "텍스트가 많아 보인다" 같은 레이아웃 추측으로 실패 처리하지 마세요 — 레이아웃 오버플로는 시스템이 실측해서 slide.overflow로 전달합니다.
4. 스타일 바이블 문법 위반인지 확인하세요. 예: 메시지 2개를 한 장에 욱여넣음, brief/essay 구조 이탈.
5. slide.overflow가 true인 슬라이드만 오버플로를 issues에 포함하고, fix에서 텍스트를 줄이세요. overflow가 없는 슬라이드에 오버플로 이슈를 만들지 마세요.

## fix 규칙
1. ok가 true면 fix는 null입니다.
2. ok가 false면 fix는 해당 슬라이드 type과 같은 텍스트 필드만 담으세요.
3. cover fix는 { "headline": "...", "kicker": "..." } 형태입니다.
4. body fix는 { "subtitle": "...", "paragraphs": ["...", "..."] } 형태입니다.
5. ending fix는 { "headline": "...", "closing": "..." } 형태입니다.
6. fix는 문제를 바로 반영한 최종 교정 텍스트여야 하며 설명 문장을 넣지 마세요.

## 출력 형식 (JSON만 출력, 다른 텍스트 금지)
{
  "results": [
    {
      "slideIndex": 0,
      "ok": true,
      "issues": [],
      "fix": null
    }
  ]
}`;
}

function buildAugmentPrompt({ topic, registeredDomains }) {
  const domainHint = registeredDomains.length > 0
    ? `\n우선 검색 도메인 (소스 레지스트리에 등록됨, 이 도메인의 기사를 먼저 찾을 것):\n${registeredDomains.join(', ')}`
    : '';

  return `주제: "${topic}"

이 주제와 관련된 최신 뉴스 기사나 분석 글의 URL을 3~5개 찾아주세요.
${domainHint}

WebSearch 도구를 사용해 검색하세요.

## 출력 형식 (JSON만 출력, 다른 텍스트 금지)
{
  "articles": [
    {
      "url": "https://...",
      "title": "기사 제목",
      "domain": "example.com",
      "relevance": "이 기사가 주제와 관련된 이유 한 줄"
    }
  ]
}`;
}

function buildTracePrompt({ title, caption, url, body, outboundLinks, mediaSummary }) {
  const links = Array.isArray(outboundLinks) && outboundLinks.length
    ? outboundLinks.map((link) => `- ${link}`).join('\n')
    : '(없음)';
  return `아래 SNS 포스트(인스타그램/스레드) 또는 기사의 콘텐츠를 분석하고 원본 소스를 추적하세요.

URL: ${url}
제목: ${title || '(없음)'}
캡션/본문: ${(caption || body || '').slice(0, 1500)}

포스트에 포함된 외부 링크 (직접 증거 — 최우선 채택, confidence 0.95+):
${links}

포스트의 실제 미디어 구성: ${mediaSummary || '확인 불가 (캡션 기반으로 추정)'}

작업 2가지:
1. 콘텐츠 인벤토리: 이 포스트가 담고 있는 콘텐츠 요소를 항목별로 식별하라 — 이미지(image), 영상(video), 텍스트 주장/인용(claim), 자료·차트·리포트(data). 각 항목이 어디서 가져온 것인지 원본을 추적하라. 외부 링크가 있으면 그것이 원본일 가능성이 높다. 없으면 WebSearch 도구로 캡션의 핵심 주장/자료를 검색해 원 출처를 찾아라.
2. 등록 후보 매체: 이 콘텐츠의 원본격 매체/기관을 소스 레지스트리에 등록할 후보로 정리하라.

## 출력 형식 (JSON만 출력, 다른 텍스트 금지)
{
  "summary": "이 포스트가 무엇인지 1~2문장 (한국어)",
  "items": [
    {
      "kind": "image|video|claim|data",
      "desc": "항목 설명 (한국어, 1문장)",
      "origin": {
        "name": "원본 매체/기관명",
        "domain": "example.com",
        "url": "원본 URL (찾은 경우만)",
        "how": "direct-link|web-search|estimate",
        "confidence": 0.9
      }
    }
  ],
  "sources": [
    {
      "name": "매체/기관명",
      "domain": "example.com",
      "type": "media|report|filing|sns|blog",
      "url": "원본 기사/리포트 URL (찾은 경우)",
      "tags": ["뉴스", "테크"],
      "confidence": 0.85
    }
  ]
}`;
}

function formatItemsForPrompt(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '(없음)';
  }

  return items.map((item, index) => {
    const ref = typeof item?.ref === 'string' && item.ref.trim() ? item.ref.trim() : `i${index + 1}`;
    const kind = typeof item?.kind === 'string' && item.kind.trim() ? item.kind.trim() : 'claim';
    const desc = typeof item?.desc === 'string' && item.desc.trim() ? item.desc.trim() : '(설명 없음)';
    const originName = typeof item?.origin?.name === 'string' && item.origin.name.trim() ? item.origin.name.trim() : '출처 미상';
    const confidence = Number.isFinite(item?.origin?.confidence)
      ? `${Math.round(Number(item.origin.confidence) * 100)}%`
      : 'n/a';
    return `- [${ref}] (${kind}, ${confidence}) ${desc} — ${originName}`;
  }).join('\n');
}

function formatOutlineForPrompt(outline, format = null) {
  const outlineItems = Array.isArray(outline)
    ? outline
    : Array.isArray(outline?.outline)
      ? outline.outline
      : [];
  const outlineFormat = normalizeOutlineFormat(format || outline?.format);

  if (outlineItems.length === 0) {
    return outlineFormat ? `- format: ${outlineFormat}` : '(없음)';
  }

  const lines = outlineItems.map((item, index) => {
    const type = item?.type || 'body';
    const role = item?.role || 'body';
    const message = item?.message || '(메시지 없음)';
    const itemRefs = Array.isArray(item?.itemRefs) && item.itemRefs.length ? item.itemRefs.join(', ') : '(없음)';
    const slideIndex = Number.isInteger(item?.slideIndex) ? item.slideIndex : index;
    const frameTs = Number.isFinite(item?.frameTs) && Number(item.frameTs) >= 0
      ? `, frameTs=${Number(item.frameTs)}`
      : '';
    return `- slide ${slideIndex}: type=${type}, role=${role}, itemRefs=${itemRefs}${frameTs}, message=${message}`;
  });

  if (outlineFormat) {
    lines.unshift(`- format: ${outlineFormat}`);
  }

  return lines.join('\n');
}

function hasOutlineContext(outline, format = null) {
  return Boolean(normalizeOutlineFormat(format || outline?.format))
    || (Array.isArray(outline) && outline.length > 0)
    || Array.isArray(outline?.outline);
}

function normalizeOutlineFormat(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return OUTLINE_FORMATS.has(trimmed) ? trimmed : null;
}

function buildOutlineSegmentContext(segments) {
  const lines = formatSegmentLines(segments);
  if (!lines.length) {
    return '';
  }
  return `\n\n## 자막 타임라인\n${sampleSegmentLines(lines, 8000)}`;
}

function formatSegmentLines(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      const t = Number(segment?.t);
      const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
      if (!Number.isFinite(t) || t < 0 || !text) {
        return null;
      }
      return `[${formatPromptTimestamp(t)}] ${text}`;
    })
    .filter(Boolean);
}

function sampleSegmentLines(lines, maxChars) {
  const normalized = Array.isArray(lines) ? lines.filter((line) => typeof line === 'string' && line.trim()) : [];
  if (!normalized.length) {
    return '';
  }

  const fullText = normalized.join('\n');
  if (fullText.length <= maxChars) {
    return fullText;
  }

  let count = Math.max(1, Math.floor((maxChars / Math.max(fullText.length, 1)) * normalized.length));
  let sampled = sampleEvenly(normalized, count);
  let text = sampled.join('\n');

  while (text.length > maxChars && count > 1) {
    count -= 1;
    sampled = sampleEvenly(normalized, count);
    text = sampled.join('\n');
  }

  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function sampleEvenly(values, count) {
  if (!Array.isArray(values) || !values.length || count <= 0) {
    return [];
  }
  if (count >= values.length) {
    return values.slice();
  }

  const result = [];
  for (let index = 0; index < count; index += 1) {
    const position = Math.floor((index * values.length) / count);
    result.push(values[Math.min(values.length - 1, position)]);
  }
  return result;
}

function formatPromptTimestamp(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatSlidesForPrompt(slides) {
  if (!Array.isArray(slides) || slides.length === 0) {
    return '(없음)';
  }

  return slides.map((slide, index) => {
    const type = slide?.type || 'body';
    const order = Number.isInteger(slide?.order) ? slide.order : index;
    const overflow = slide?.overflow ? 'true' : 'false';
    const text = slide?.text || slide || {};

    if (type === 'cover') {
      return `- slide ${order}: type=cover, overflow=${overflow}, headline=${JSON.stringify(text.headline || '')}, kicker=${JSON.stringify(text.kicker || '')}`;
    }

    if (type === 'ending') {
      return `- slide ${order}: type=ending, overflow=${overflow}, headline=${JSON.stringify(text.headline || '')}, closing=${JSON.stringify(text.closing || '')}`;
    }

    return `- slide ${order}: type=body, overflow=${overflow}, subtitle=${JSON.stringify(text.subtitle || '')}, paragraphs=${JSON.stringify(Array.isArray(text.paragraphs) ? text.paragraphs : [])}`;
  }).join('\n');
}

function resolveSourceNames({ sourceNames = [], outline = [], items = [], sources = [] }) {
  const explicit = uniqueStrings(sourceNames);
  if (explicit.length > 0) {
    return explicit;
  }

  const refs = new Set();
  const outlineItems = Array.isArray(outline)
    ? outline
    : Array.isArray(outline?.outline)
      ? outline.outline
      : [];
  if (Array.isArray(outlineItems)) {
    for (const item of outlineItems) {
      if (!Array.isArray(item?.itemRefs)) {
        continue;
      }
      for (const ref of item.itemRefs) {
        if (typeof ref === 'string' && ref.trim()) {
          refs.add(ref.trim());
        }
      }
    }
  }

  const itemNames = Array.isArray(items)
    ? items
      .filter((item) => refs.has(item?.ref))
      .map((item) => item?.origin?.name)
    : [];
  const resolvedItemNames = uniqueStrings(itemNames);
  if (resolvedItemNames.length > 0) {
    return resolvedItemNames;
  }

  return uniqueStrings(Array.isArray(sources) ? sources.map((source) => source?.name) : []);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function buildAppendPrompt({
  title,
  body,
  tone,
  imageCandidates = [],
  slides = [],
  styleBible,
  angle = null,
  instruction,
}) {
  const toneInstruction = tone?.promptSuffix || '';
  const styleBibleText = typeof styleBible === 'string' ? styleBible : loadStyleBible();
  const imageInfo = imageCandidates.length > 0
    ? `\n사용 가능한 이미지: ${imageCandidates.length}장 (photo 필드에 0부터 인덱스로 지정, 마땅한 게 없으면 null)`
    : '';
  const angleContext = angle && (angle.title || angle.hook)
    ? `\n포스트 앵글: ${angle.title || ''} — ${angle.hook || ''}`
    : '';
  const slidesText = slides
    .map((slide, index) => {
      const text = slide.text || {};
      const head = [text.kicker, text.headline, text.subtitle]
        .filter((value) => typeof value === 'string' && value.trim())
        .join(' / ');
      const paragraphs = Array.isArray(text.paragraphs)
        ? text.paragraphs.filter((item) => typeof item === 'string' && item.trim()).join(' | ')
        : '';
      return `${index + 1}. [${slide.type}] ${head}${paragraphs ? ` — ${paragraphs}` : ''}`.replace(/\n/g, ' ');
    })
    .join('\n');

  return `당신은 인스타그램 매거진 캐러셀 에디터입니다.
이미 완성된 캐러셀에 에디터의 지시에 따라 body 슬라이드를 추가합니다. 기존 슬라이드는 절대 수정하지 않습니다.

## 스타일 바이블
${styleBibleText || '(없음)'}

## 소재 (사실 근거는 반드시 여기서만)
제목: ${title || '(없음)'}
본문:
${body || '(없음)'}
${imageInfo}${angleContext}

## 현재 슬라이드 구성
${slidesText || '(없음)'}

## 🧭 에디터 추가 지시 (최우선 반영)
${String(instruction || '').trim()}

## 지시사항
1. 위 지시를 충족하는 새 body 슬라이드를 1~3장 작성하세요. 기존 슬라이드와 내용이 겹치면 안 됩니다.
2. 소재 본문에 없는 수치·발언·고유명사를 지어내면 안 됩니다. 발언 인용은 소재 본문(스크립트)에 실제로 있는 문장만 사용하세요.
3. insertAfter는 새 슬라이드를 끼워 넣을 위치입니다. "현재 슬라이드 구성"의 번호 기준으로, 그 번호 슬라이드 바로 뒤에 들어갑니다. 흐름상 가장 자연스러운 위치를 고르세요(ending 뒤는 불가).

${toneInstruction}

## 슬라이드 텍스트 제한 (반드시 준수)
- body: subtitle은 반드시 한 줄 — \\n 금지(렌더러가 폭에 맞춰 크기 조절). 번호 전개면 "1. " prefix 사용.
- body paragraphs: 완결 문장으로 자연스럽게 쓰고 \\n을 넣지 마세요(렌더러가 자동 줄바꿈). 단락당 1~3문장, 단락 최대 3개. 마지막 단락은 _밑줄_ 펀치라인 1문장.
- 하이라이트 마크업: [단어] (슬라이드당 1~2개만). 밑줄: _문장_ (줄 앞뒤에 _)
- \\n으로 줄바꿈 명시.

## 출력 형식 (JSON만 출력, 다른 텍스트 금지)
{
  "insertAfter": 3,
  "slides": [
    {
      "subtitle": "한 줄 소제목입니다",
      "paragraphs": ["완결 문장으로 쓴 단락입니다. 렌더러가 알아서 줄을 바꿉니다.", "_마지막 펀치라인 한 문장._"],
      "photo": 1
    }
  ]
}`;
}

module.exports = {
  loadStyleBible,
  loadThreadDna,
  buildWritePrompt,
  buildAppendPrompt,
  buildAnglesPrompt,
  buildOutlinePrompt,
  buildVerifyPrompt,
  buildAugmentPrompt,
  buildTracePrompt,
  buildThreadPrompt,
  normalizeThreadIntensity,
};
