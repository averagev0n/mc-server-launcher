// Понятные объяснения ошибок сервера.
// Журнал сервера почти всегда на английском и полон технических подробностей.
// Здесь собраны частые проблемы: по строкам журнала узнаём, что случилось,
// и объясняем по-русски, что делать. Сами ошибки не правим — только подсказываем.

/** Версия Java по номеру формата class-файлов: 61 → 17, 65 → 21. */
const javaOfClassVersion = (v) => Number(v) - 44;

const clean = (s) => String(s || '').trim().replace(/^['"]|['"]$/g, '');

// Зависимости, которые ставятся не модом, а выбором версии в лаунчере.
function special(depId) {
  if (/^(minecraft)$/i.test(depId)) return 'minecraft';
  if (/^(fabricloader|fabric-loader|forge|neoforge|fml|javafml|quilt_loader)$/i.test(depId)) return 'loader';
  if (/^java$/i.test(depId)) return 'java';
  return null;
}

// Fabric API состоит из десятков модулей (fabric-api-base, fabric-command-api-v2…) —
// игроку достаточно знать, что не хватает Fabric API целиком.
const isFabricApiPart = (id) =>
  /^fabric-api(-base)?$|^fabric-[\w-]+-v\d+$|^fabric-[\w-]+-api(-v\d+)?$/.test(String(id || '')) && id !== 'fabric-language-kotlin';

/** Диапазон версий Maven в обычных словах: «[1.2,)» → «1.2 или новее». */
function prettyRange(r) {
  const s = String(r || '').trim();
  let m = s.match(/^\[([^,\]]+)\]$/);
  if (m) return m[1];
  m = s.match(/^[[(]([^,]*),([^\])]*)[\])]$/);
  if (m) {
    if (m[1] && !m[2]) return `${m[1]} или новее`;
    if (!m[1] && m[2]) return `до ${m[2]}`;
    if (m[1] && m[2]) return `от ${m[1]} до ${m[2]}`;
  }
  return s;
}

/** Ключ, по которому одинаковые «не хватает X» склеиваются в одну карточку. */
const depKey = (id) => (isFabricApiPart(id) ? 'fabric-api' : String(id || '').toLowerCase());

/** Объяснение «не хватает зависимости» с учётом того, что это за зависимость. */
function missingDep({ mod, depName, depId, range, actual }) {
  if (isFabricApiPart(depId)) {
    depId = 'fabric-api';
    depName = 'Fabric API';
    range = '';
  }
  range = prettyRange(range);
  const sp = special(depId);
  const who = mod ? `Мод «${mod}»` : 'Один из модов';
  if (sp === 'minecraft') {
    return {
      title: `${mod ? `«${mod}»` : 'Мод'} — для другой версии игры`,
      text: `${who} сделан для Minecraft ${range || 'другой версии'}, а сервер — ${actual && actual !== '[MISSING]' ? actual : 'другой версии'}.`,
      fix: ['Удалите этот мод или скачайте его версию для вашей версии игры (во вкладке «Моды» поиск сам подбирает подходящие).'],
      actions: [{ type: 'mods', label: 'Открыть моды' }],
    };
  }
  if (sp === 'loader') {
    return {
      title: 'Мод требует более новую версию загрузчика',
      text: `${who} требует ${depName || depId} ${range || 'другой версии'}${actual && actual !== '[MISSING]' ? `, а установлен ${actual}` : ''}.`,
      fix: ['Выберите в левой панели более новую версию загрузчика и перезапустите сервер — мир и моды сохранятся.'],
      actions: [],
    };
  }
  if (sp === 'java') {
    return {
      title: 'Мод требует другую Java',
      text: `${who} требует Java ${range || 'другой версии'}.`,
      fix: ['Выберите подходящую Java в блоке «Запуск» или установите её.'],
      actions: [],
    };
  }
  const name = depName || depId;
  if (actual && actual !== '[MISSING]' && !/missing/i.test(actual)) {
    return {
      title: `Не та версия мода «${name}»`,
      text: `${who} требует «${name}» ${range || 'другой версии'}, а установлена версия ${actual}.`,
      fix: [`Обновите «${name}» (удалите старый файл и установите заново во вкладке «Моды»).`],
      actions: [{ type: 'search', label: `Найти «${name}»`, query: depId || name }],
    };
  }
  return {
    title: `Не хватает мода «${name}»`,
    text: `${who} не работает без мода «${name}», а его на сервере нет.`,
    fix: [`Установите «${name}» во вкладке «Моды» — найдётся по кнопке ниже.`, 'Или удалите мод, которому он нужен.'],
    actions: [{ type: 'search', label: `Найти «${name}»`, query: depId || name }],
  };
}

/**
 * Правила: test — регулярное выражение по одной строке журнала;
 * build(match, ctx, near) — объяснение; near — соседние строки для уточнений.
 * key(match) — чтобы одна и та же проблема не показывалась много раз.
 */
const RULES = [
  {
    id: 'eula',
    test: /You need to agree to the EULA|Вы должны согласиться с Пользовательским Соглашением/i,
    build: () => ({
      title: 'Не принято лицензионное соглашение',
      text: 'Сервер Minecraft не запускается, пока не принято лицензионное соглашение Mojang (EULA).',
      fix: ['Поставьте галочку «Я принимаю лицензионное соглашение» в блоке «Запуск» и запустите сервер снова.'],
    }),
  },
  {
    id: 'bad-ip',
    test: /Cannot assign requested address|Can't assign requested address|address is not valid in its context/i,
    build: (m, ctx) => ({
      title: `Адреса ${ctx.ip || 'сервера'} нет на этом компьютере`,
      text: 'В настройках сервера выбран IP, которого у компьютера сейчас нет. Так бывает, если выключили VPN (Radmin, Hamachi, ZeroTier) или сменилась сеть.',
      fix: [
        'Включите нужную сеть или VPN.',
        'Или в «Настройках сервера» слева выберите «Все адреса компьютера», сохраните и запустите снова.',
      ],
    }),
  },
  {
    id: 'port',
    test: /FAILED TO BIND TO PORT|BindException|Address already in use/i,
    build: (m, ctx) => ({
      title: `Порт ${ctx.port || ''} уже занят`.trim(),
      text: 'Этот порт уже использует другая программа. Чаще всего это второй запущенный сервер — в этом лаунчере, в другом окне или в игре через «Открыть для сети».',
      fix: [
        'Остановите другой сервер или закройте его окно.',
        'Или поменяйте порт в «Настройках сервера» слева (например, на 25566), сохраните и запустите снова. Игрокам тогда нужно добавлять порт к адресу: «адрес:25566».',
      ],
    }),
  },
  {
    id: 'lock',
    test: /session\.lock|directory is already locked|already locked by another|Failed to check session lock/i,
    build: () => ({
      title: 'Мир уже открыт другим сервером',
      text: 'Этот мир сейчас использует другой запущенный сервер (или он не закрылся до конца после прошлого запуска).',
      fix: ['Закройте другой сервер. Если его нет — подождите минуту или перезагрузите компьютер.'],
    }),
  },
  {
    id: 'oom',
    test: /OutOfMemoryError(?::\s*(.+))?/,
    build: (m, ctx) => ({
      title: 'Серверу не хватило памяти',
      text: `Сервер занял всю выделенную ему память${ctx.ramGb ? ` (${ctx.ramGb} ГБ)` : ''} и упал.`,
      fix: [
        'Увеличьте «Память» в блоке «Запуск» — для сервера с модами обычно нужно 4–8 ГБ.',
        'Уменьшите дальность прорисовки (view-distance) во вкладке «Конфиги» → server.properties.',
        'Если памяти в компьютере мало — уберите тяжёлые моды.',
      ],
      actions: [{ type: 'ram', label: 'К настройке памяти' }],
    }),
  },
  {
    id: 'java-old',
    test: /class file version (\d+)(?:\.\d+)?[^\n]*?up to (\d+)/,
    key: (m) => m[1],
    build: (m) => {
      const need = javaOfClassVersion(m[1]);
      const have = javaOfClassVersion(m[2]);
      return {
        title: `Нужна Java ${need}, а запущена Java ${have}`,
        text: `Сервер или один из модов собран для Java ${need} и новее, а лаунчер запустил его на Java ${have}.`,
        fix: [`Выберите в блоке «Запуск» Java ${need} или новее. Если такой нет — установите её.`],
        actions: [{ type: 'java', label: `Установить Java ${need}`, version: need }],
      };
    },
  },
  {
    id: 'java-new',
    test: /Unsupported class file major version (\d+)|does not export sun\.[\w.]+ to unnamed module|IllegalAccessError: class cpw\.mods|Unsupported Java detected|requires Java (\d+) or below/,
    build: (m, ctx) => {
      const java = m[1] ? javaOfClassVersion(m[1]) : ctx.javaMajor;
      return {
        title: 'Java слишком новая для этой версии',
        text: `Эта версия сервера или загрузчика модов не умеет работать с Java ${java || 'этой версии'}. Так бывает со старыми версиями игры (обычно до 1.17).`,
        fix: [
          'Выберите в блоке «Запуск» более старую Java: для 1.12–1.16 нужна Java 8, для 1.17 — 16, для 1.18–1.20.4 — 17.',
          'Если нужной Java нет в списке — установите её.',
        ],
        actions: [{ type: 'java', label: 'Установить Java 8', version: 8 }, { type: 'java', label: 'Установить Java 17', version: 17 }],
      };
    },
  },
  // Fabric: «Mod 'A' (a) 1.0 requires any version of mod 'B' (b), which is missing!»
  {
    id: 'fabric-dep',
    test: /Mod '([^']+)' \(([^)]+)\)[^\n]*? requires ([^\n]*?) of (?:mod )?(?:'([^']+)' \(([^)]+)\)|([\w.-]+)),?\s*(which is missing|but only the wrong version is present:?\s*(\S+)?)/,
    key: (m) => depKey(m[5] || m[6]),
    build: (m) =>
      missingDep({
        mod: m[1],
        depName: m[4] || m[6],
        depId: m[5] || m[6],
        range: m[3].replace(/^(any version|version)\s*/, '').trim() || '',
        actual: /missing/.test(m[7]) ? '[MISSING]' : m[8] || 'другая',
      }),
  },
  {
    id: 'fabric-incompat',
    test: /Mod '([^']+)' \(([^)]+)\)[^\n]*? is incompatible with (?:any version of )?(?:mod )?(?:'([^']+)'|([\w.-]+))/,
    key: (m) => `${m[2]}x${m[3] || m[4]}`,
    build: (m) => ({
      title: `«${m[1]}» несовместим с «${m[3] || m[4]}»`,
      text: `Эти два мода не могут работать вместе — так решили их авторы.`,
      fix: ['Оставьте только один из них.'],
      actions: [{ type: 'mods', label: 'Открыть моды' }],
    }),
  },
  // Forge: «Mod ID: 'b', Requested by: 'a', Expected range: '[1.0,)', Actual version: '[MISSING]'»
  {
    id: 'forge-dep',
    test: /Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '([^']*)'/,
    key: (m) => (special(m[1]) ? `${m[2]}>${m[1]}` : depKey(m[1])),
    build: (m) => missingDep({ mod: m[2], depId: m[1], depName: m[1], range: m[3], actual: m[4] }),
  },
  // NeoForge: «Mod X requires Y 1.2 or above» + «Currently, Y is not installed»
  {
    id: 'neo-dep',
    test: /Currently, ([\w.-]+) is (not installed|[\w.+-]+)/,
    key: (m) => depKey(m[1]),
    build: (m, ctx, near) => {
      const req = near.map((l) => l.match(/Mod (.+?) requires ([\w.-]+) (.+)$/)).find((x) => x && x[2] === m[1]);
      return missingDep({
        mod: req ? req[1] : null,
        depId: m[1],
        depName: m[1],
        range: req ? req[3] : '',
        actual: m[2] === 'not installed' ? '[MISSING]' : m[2],
      });
    },
  },
  {
    id: 'client-only',
    test: /invalid dist DEDICATED_SERVER|Attempted to load class net\/minecraft\/client|Environment type SERVER is not supported|net\.minecraft\.client\.(?:Minecraft|gui|renderer)|NoClassDefFoundError: net\/minecraft\/client/,
    build: (m, ctx, near) => {
      // Forge/NeoForge пишут рядом путь к файлу мода: «Mod File: /…/mods/xaerominimap.jar».
      const modLine = near.map((l) => l.match(/Mod File:\s*(?:.*[\\/])?([^\\/\s]+\.jar)/i)).find(Boolean);
      const mod = modLine ? modLine[1] : null;
      return {
        title: 'На сервере стоит мод только для игры',
        text: `${mod ? `Мод «${mod}»` : 'Один из модов'} работает только в игре у игрока (например, миникарта, шейдеры, меню или улучшения графики), а на сервере он ломает запуск.`,
        fix: ['Удалите этот мод из папки mods на сервере. Игрокам он может остаться в их игре.'],
        actions: [{ type: 'mods', label: 'Открыть установленные моды' }],
      };
    },
  },
  {
    id: 'mixin',
    test: /Mixin apply(?: for mod ([\w.-]+))? failed|MixinApplyError|InvalidInjectionException|Mixin \[[^\]]+\] from mod ([\w.-]+)|Critical injection failure/,
    key: (m) => m[1] || m[2] || 'mixin',
    build: (m) => {
      const mod = m[1] || m[2];
      return {
        title: mod ? `Мод «${mod}» не смог встроиться в игру` : 'Мод не смог встроиться в игру',
        text: `${mod ? `«${mod}»` : 'Один из модов'} не подходит к этой версии игры или загрузчика, либо конфликтует с другим модом, который меняет то же самое.`,
        fix: [
          mod ? `Обновите «${mod}» до версии для вашей игры или удалите его.` : 'Удалите недавно добавленные моды по одному, чтобы найти виновника.',
          'Если мод свежий — проверьте, не стоит ли другой мод с похожими функциями.',
        ],
        actions: mod ? [{ type: 'search', label: `Найти «${mod}»`, query: mod }] : [{ type: 'mods', label: 'Открыть моды' }],
      };
    },
  },
  {
    id: 'duplicate',
    test: /Duplicate mods? found|DuplicateModsFoundException|Found duplicate mods|is loaded multiple times|Found \d+ duplicate mods?/i,
    build: () => ({
      title: 'Один и тот же мод установлен дважды',
      text: 'В папке mods лежат две версии одного мода — загрузчик не знает, какую взять.',
      fix: ['Откройте установленные моды и удалите старую копию.'],
      actions: [{ type: 'mods', label: 'Открыть установленные моды' }],
    }),
  },
  {
    id: 'plugin-dep',
    test: /Unknown\/missing dependency plugins: \[([^\]]+)\]/,
    key: (m) => m[1],
    build: (m, ctx, near) => {
      const owner = near.map((l) => l.match(/Could not load '(?:plugins[\\/])?([^']+?)(?:\.jar)?'/)).find(Boolean);
      const deps = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      return {
        title: `Плагину не хватает: ${deps.join(', ')}`,
        text: `${owner ? `Плагин «${owner[1]}»` : 'Плагин'} не работает без ${deps.length > 1 ? 'плагинов' : 'плагина'} ${deps.map((d) => `«${d}»`).join(', ')}.`,
        fix: ['Установите недостающее во вкладке «Плагины».'],
        actions: deps.slice(0, 3).map((d) => ({ type: 'search', label: `Найти «${d}»`, query: d, kind: 'plugin' })),
      };
    },
  },
  {
    id: 'plugin-api',
    test: /Unsupported API version (\S+)/,
    key: (m) => m[1],
    build: (m, ctx, near) => {
      const owner = near.map((l) => l.match(/Could not load '(?:plugins[\\/])?([^']+?)(?:\.jar)?'/)).find(Boolean);
      return {
        title: `${owner ? `«${owner[1]}»` : 'Плагин'} — для более новой версии игры`,
        text: `Плагин сделан для Minecraft ${m[1]} и новее, а сервер — ${ctx.version || 'старее'}.`,
        fix: ['Скачайте версию плагина для вашей версии игры или удалите его.'],
        actions: [{ type: 'mods', label: 'Открыть плагины', kind: 'plugin' }],
      };
    },
  },
  {
    id: 'plugin-enable',
    test: /Error occurred while enabling (\S+)/,
    key: (m) => m[1],
    build: (m) => ({
      title: `Плагин «${m[1]}» не запустился`,
      text: 'Плагин упал при включении. Обычно он устарел для этой версии сервера или неправильно настроен.',
      fix: [`Обновите «${m[1]}» или проверьте его настройки во вкладке «Конфиги». Если не нужен — удалите.`],
      actions: [{ type: 'search', label: `Найти «${m[1]}»`, query: m[1], kind: 'plugin' }],
    }),
  },
  {
    id: 'plugin-load',
    test: /Could not load '(?:plugins[\\/])?([^']+?)(?:\.jar)?' in folder/,
    key: (m) => m[1],
    build: (m) => ({
      title: `Плагин «${m[1]}» не загрузился`,
      text: 'Файл плагина повреждён, не подходит к этой версии сервера или ему чего-то не хватает (подробности — в строках ниже в консоли).',
      fix: ['Скачайте плагин заново для вашей версии игры или удалите его.'],
      actions: [{ type: 'mods', label: 'Открыть плагины', kind: 'plugin' }],
    }),
  },
  {
    id: 'world-newer',
    test: /saved with a newer version|Cannot load world saved with newer version|world was saved with.*newer|newer data ?version/i,
    build: () => ({
      title: 'Мир создан в более новой версии игры',
      text: 'Этот мир сохраняли на более новой версии Minecraft. Старая версия не может его открыть.',
      fix: ['Выберите ту же или более новую версию игры, что и раньше.', 'Или создайте новый мир: поменяйте level-name в «Конфигах» → server.properties.'],
    }),
  },
  {
    id: 'datapack',
    test: /Errors in currently selected data ?packs|Failed to load datapacks|Failed to load registries due to above errors|Failed to load data packs/i,
    build: () => ({
      title: 'Не загружаются данные мира',
      text: 'Мир ссылается на блоки, предметы или измерения, которых сейчас нет. Обычно так бывает, если удалили мод, который их добавлял, или поставили мод не для этой версии.',
      fix: ['Верните удалённый мод или уберите недавно добавленный.', 'Посмотрите выше в консоли — там бывает название мода.'],
    }),
  },
  {
    id: 'network',
    test: /UnknownHostException|SocketTimeoutException|ConnectException: Connection (?:timed out|refused)|Failed to download|Could not download/i,
    build: () => ({
      title: 'Не удалось скачать файлы',
      text: 'При запуске сервер докачивает нужные файлы, но связь с интернетом пропала или сайт недоступен.',
      fix: ['Проверьте интернет и запустите сервер снова.', 'Если включён VPN или прокси — попробуйте без него (или наоборот с ним).'],
    }),
  },
  {
    id: 'jarfile',
    test: /Unable to access jarfile|Could not find or load main class|Invalid or corrupt jarfile|zip END header not found/i,
    build: () => ({
      title: 'Файл сервера повреждён или пропал',
      text: 'Не удалось открыть файл сервера — возможно, загрузка прервалась или его удалил антивирус.',
      fix: ['Удалите из папки сервера файл launcher.json — при следующем запуске лаунчер установит сервер заново (мир и моды сохранятся).'],
      actions: [{ type: 'folder', label: 'Открыть папку сервера' }],
    }),
  },
  {
    id: 'lag',
    severity: 'warn',
    test: /Can't keep up! .*?Running (\d+)ms or (\d+) ticks behind/,
    key: () => 'lag',
    build: (m) => ({
      title: 'Сервер не успевает',
      text: `Сервер отстал на ${(Number(m[1]) / 1000).toFixed(1).replace('.', ',')} с. Игроки заметят задержки. Если это было один раз при загрузке мира — ничего страшного.`,
      fix: [
        'Если повторяется: уменьшите view-distance и simulation-distance в «Конфигах» → server.properties.',
        'Выделите больше памяти или уберите тяжёлые моды и плагины.',
      ],
    }),
  },
  {
    id: 'crash-report',
    severity: 'info',
    test: /(?:crash report has been saved to|Crash report saved to|This crash report has been saved to):?\s*(.+)$/i,
    key: () => 'report',
    build: (m) => ({
      title: 'Сохранён отчёт о падении',
      text: 'Сервер записал подробный отчёт об ошибке. Его можно отправить автору мода или на форум.',
      fix: [],
      actions: [{ type: 'open', label: 'Открыть отчёт', path: clean(m[1]) }],
    }),
  },
  {
    id: 'tick-crash',
    test: /Encountered an unexpected exception|Exception in server tick loop|Exception stopping the server|Failed to start the minecraft server/,
    key: () => 'tick',
    build: (m, ctx) => ({
      title: 'Сервер упал из-за ошибки',
      text: `Во время работы произошла ошибка, и сервер остановился. Чаще всего виноват мод или плагин${ctx.modded ? ', добавленный недавно' : ''}.`,
      fix: [
        'Посмотрите карточки выше и ниже — иногда причина уже найдена.',
        'Если причины не видно: уберите недавно добавленные моды или плагины и запустите снова.',
        'Отчёт о падении (если сохранён) можно отправить автору мода.',
      ],
    }),
  },
];

/**
 * Ищет проблемы в строках журнала.
 * lines — массив строк; from — с какой строки искать (раньше уже проверено).
 * Возвращает [{ key, id, severity, title, text, fix, actions, line }].
 */
function diagnose(lines, from, ctx) {
  const found = [];
  for (let i = Math.max(0, from); i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 4000) continue;
    for (const rule of RULES) {
      const m = line.match(rule.test);
      if (!m) continue;
      const near = lines.slice(Math.max(0, i - 15), i + 15);
      let issue;
      try {
        issue = rule.build(m, ctx || {}, near);
      } catch {
        continue;
      }
      found.push({
        key: `${rule.id}:${rule.key ? rule.key(m) : ''}`,
        id: rule.id,
        severity: rule.severity || 'error',
        fix: [],
        actions: [],
        ...issue,
        line: line.trim().slice(0, 500),
      });
      break; // одна строка — одно объяснение
    }
  }
  return found;
}

/** Общее объяснение, если сервер упал, а причина не распознана. */
function unknownCrash(code, ctx) {
  return {
    key: 'unknown-crash',
    id: 'unknown-crash',
    severity: 'error',
    title: 'Сервер остановился с ошибкой',
    text: `Сервер завершился с кодом ${code}, и точную причину лаунчер не распознал. Обычно подробности — в красных строках консоли незадолго до остановки${ctx && ctx.modded ? '; часто виноват недавно добавленный мод или плагин' : ''}.`,
    fix: [
      'Уберите недавно добавленные моды или плагины и запустите снова.',
      'Если не помогает — скопируйте журнал кнопкой ниже и спросите на форуме или у автора мода: по журналу причину обычно видно сразу.',
    ],
    actions: [{ type: 'copy', label: 'Скопировать журнал' }, { type: 'logs', label: 'Открыть папку логов' }],
    line: '',
  };
}

module.exports = { diagnose, unknownCrash, RULES };
