import { interface as dbusInterface, Message, sessionBus, Variant, type Interface, type MessageBus } from "@jellybrick/dbus-next";

const BUS_NAME = "org.pipeq.PipeQ";
const ITEM_PATH = "/org/pipeq/PipeQ/StatusNotifierItem";
const MENU_PATH = `${ITEM_PATH}/Menu`;
const WATCHER_NAME = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH = "/StatusNotifierWatcher";
const WATCHER_INTERFACE = "org.kde.StatusNotifierWatcher";

const MENU_ENABLED = 1;
const MENU_PRESETS = 2;
const MENU_OUTPUTS = 3;
const MENU_OPEN_WEB_UI = 4;
const MENU_QUIT = 5;
const PRESET_ITEM_START = 1_000;
const OUTPUT_ITEM_START = 1_000_000;

export type TrayChoice = {
  id: string;
  label: string;
};

export type TrayState = {
  enabled: boolean;
  presets: readonly TrayChoice[];
  outputs: readonly TrayChoice[];
  selectedPresetId?: string;
  selectedOutputId?: string;
};

/** Callbacks that connect the desktop shell to PipeQ's shared application state. */
export type TrayOptions = {
  /** Returns current state each time the menu is opened or explicitly refreshed. */
  getState: () => TrayState | Promise<TrayState>;
  setEnabled: (enabled: boolean) => void | Promise<void>;
  selectPreset: (presetId: string) => void | Promise<void>;
  selectOutput: (outputId: string) => void | Promise<void>;
  openWebUi: () => void | Promise<void>;
  quit: () => void | Promise<void>;
  title?: string;
  iconName?: string;
  /** Receives recoverable DBus and action errors. A missing tray watcher is recoverable. */
  onError?: (error: Error) => void;
};

export type TrayController = {
  /** True after PipeQ owns its StatusNotifierItem bus name. */
  readonly running: boolean;
  /** Rebuilds the menu from `getState` and signals supporting desktop shells. */
  update: () => Promise<void>;
  /** Removes DBus exports and releases the session bus connection. Safe to call more than once. */
  stop: () => Promise<void>;
};

type MenuNode = [number, Record<string, Variant>, Variant<MenuNode>[]];

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function labelProperties(label: string): Record<string, Variant> {
  return {
    label: new Variant("s", label),
    enabled: new Variant("b", true),
    visible: new Variant("b", true),
  };
}

function submenu(id: number, label: string, children: MenuNode[]): MenuNode {
  return [
    id,
    { ...labelProperties(label), "children-display": new Variant("s", "submenu") },
    children.map((child) => new Variant("(ia{sv}av)", child)),
  ];
}

function action(id: number, label: string, active: boolean): MenuNode {
  return [
    id,
    {
      ...labelProperties(label),
      "toggle-type": new Variant("s", "radio"),
      "toggle-state": new Variant("i", active ? 1 : 0),
    },
    [],
  ];
}

function separator(id: number): MenuNode {
  return [id, { type: new Variant("s", "separator") }, []];
}

// `configureMembers` stores metadata on the subclass prototype, while Interface's constructor
// creates empty own member fields. Copy the configured metadata onto each exported instance.
function installConfiguredMembers(iface: Interface): void {
  const prototype = Object.getPrototypeOf(iface) as Interface;
  if (prototype.$properties) iface.$properties = prototype.$properties;
  if (prototype.$methods) iface.$methods = prototype.$methods;
  if (prototype.$signals) iface.$signals = prototype.$signals;
}

class StatusNotifierItem extends dbusInterface.Interface {
  #enabled = true;
  #title: string;
  #iconName: string;

  constructor(title: string, iconName: string, private readonly refreshMenu: () => Promise<void>) {
    super("org.kde.StatusNotifierItem");
    installConfiguredMembers(this);
    this.#title = title;
    this.#iconName = iconName;
  }

  get Category(): string { return "ApplicationStatus"; }
  get Id(): string { return "pipeq"; }
  get Title(): string { return this.#title; }
  get Status(): string { return this.#enabled ? "Active" : "Passive"; }
  get IconName(): string { return this.#iconName; }
  get IconPixmap(): Array<[number, number, Buffer]> {
    const size = 24;
    const pixels = Buffer.alloc(size * size * 4);
    const bars = [{ x: 4, top: 12 }, { x: 9, top: 6 }, { x: 14, top: 9 }, { x: 19, top: 3 }];
    for (const bar of bars) {
      for (let y = bar.top; y < 21; y += 1) {
        for (let x = bar.x; x < bar.x + 2; x += 1) {
          const offset = (y * size + x) * 4;
          pixels[offset] = 255;
          pixels[offset + 1] = 243;
          pixels[offset + 2] = 181;
          pixels[offset + 3] = 98;
        }
      }
    }
    return [[size, size, pixels]];
  }
  get Menu(): string { return MENU_PATH; }
  get ItemIsMenu(): boolean { return false; }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  async Activate(): Promise<void> {
    await this.refreshMenu();
  }

  async ContextMenu(): Promise<void> {
    await this.refreshMenu();
  }

  async SecondaryActivate(): Promise<void> {
    await this.refreshMenu();
  }

  NewStatus(status: string): string { return status; }
}

StatusNotifierItem.configureMembers({
  properties: {
    Category: { signature: "s", access: "read" },
    Id: { signature: "s", access: "read" },
    Title: { signature: "s", access: "read" },
    Status: { signature: "s", access: "read" },
    IconName: { signature: "s", access: "read" },
    IconPixmap: { signature: "a(iiay)", access: "read" },
    Menu: { signature: "o", access: "read" },
    ItemIsMenu: { signature: "b", access: "read" },
  },
  methods: {
    Activate: { inSignature: "ii" },
    ContextMenu: { inSignature: "ii" },
    SecondaryActivate: { inSignature: "ii" },
  },
  signals: { NewStatus: { signature: "s" } },
});

class DbusMenu extends dbusInterface.Interface {
  #revision = 0;
  #state: TrayState = { enabled: true, presets: [], outputs: [] };

  constructor(private readonly options: TrayOptions, private readonly reportError: (error: unknown) => void) {
    super("com.canonical.dbusmenu");
    installConfiguredMembers(this);
  }

  get Version(): number { return 3; }
  get TextDirection(): string { return "ltr"; }
  get Status(): string { return "normal"; }

  async update(): Promise<TrayState> {
    this.#state = await this.options.getState();
    this.#revision += 1;
    this.LayoutUpdated(this.#revision, 0);
    return this.#state;
  }

  GetLayout(): [number, MenuNode] {
    return [this.#revision, this.layout()];
  }

  async Event(id: number, eventId: string): Promise<void> {
    if (eventId !== "clicked") return;
    try {
      if (id === MENU_ENABLED) await this.options.setEnabled(!this.#state.enabled);
      else if (id >= PRESET_ITEM_START && id < OUTPUT_ITEM_START) {
        const preset = this.#state.presets[id - PRESET_ITEM_START];
        if (preset) await this.options.selectPreset(preset.id);
      } else if (id >= OUTPUT_ITEM_START) {
        const output = this.#state.outputs[id - OUTPUT_ITEM_START];
        if (output) await this.options.selectOutput(output.id);
      } else if (id === MENU_OPEN_WEB_UI) await this.options.openWebUi();
      else if (id === MENU_QUIT) await this.options.quit();
      await this.update();
    } catch (error) {
      this.reportError(error);
    }
  }

  async AboutToShow(): Promise<boolean> {
    try {
      await this.update();
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  LayoutUpdated(revision: number, parent: number): [number, number] { return [revision, parent]; }

  private layout(): MenuNode {
    const presetItems = this.#state.presets.map((preset, index) => action(PRESET_ITEM_START + index, preset.label, preset.id === this.#state.selectedPresetId));
    const outputItems = this.#state.outputs.map((output, index) => action(OUTPUT_ITEM_START + index, output.label, output.id === this.#state.selectedOutputId));
    const enabled: MenuNode = [
      MENU_ENABLED,
      {
        ...labelProperties("Enable PipeQ"),
        "toggle-type": new Variant("s", "checkmark"),
        "toggle-state": new Variant("i", this.#state.enabled ? 1 : 0),
      },
      [],
    ];

    return [
      0,
      labelProperties("PipeQ"),
      [
        new Variant("(ia{sv}av)", enabled),
        new Variant("(ia{sv}av)", separator(6)),
        new Variant("(ia{sv}av)", submenu(MENU_PRESETS, "Preset", presetItems)),
        new Variant("(ia{sv}av)", submenu(MENU_OUTPUTS, "Output device", outputItems)),
        new Variant("(ia{sv}av)", separator(7)),
        new Variant("(ia{sv}av)", [MENU_OPEN_WEB_UI, labelProperties("Open web UI"), []]),
        new Variant("(ia{sv}av)", [MENU_QUIT, labelProperties("Quit PipeQ"), []]),
      ],
    ];
  }
}

DbusMenu.configureMembers({
  properties: {
    Version: { signature: "u", access: "read" },
    TextDirection: { signature: "s", access: "read" },
    Status: { signature: "s", access: "read" },
  },
  methods: {
    GetLayout: { inSignature: "iias", outSignature: "u(ia{sv}av)" },
    Event: { inSignature: "isvu" },
    AboutToShow: { inSignature: "i", outSignature: "b" },
  },
  signals: { LayoutUpdated: { signature: "ui" } },
});

async function registerWithWatcher(bus: MessageBus, reportError: (error: unknown) => void): Promise<void> {
  try {
    await bus.call(new Message({
      destination: WATCHER_NAME,
      path: WATCHER_PATH,
      interface: WATCHER_INTERFACE,
      member: "RegisterStatusNotifierItem",
      signature: "s",
      body: [BUS_NAME],
    }));
  } catch (error) {
    // The exported item remains usable by watcher implementations that discover items later.
    reportError(error);
  }
}

/**
 * Starts an optional StatusNotifierItem service on the session bus.
 *
 * Failure to connect to a desktop session is reported through `onError` and returns a stopped,
 * no-op controller so PipeQ continues to work in terminals and headless sessions.
 */
export async function startTray(options: TrayOptions): Promise<TrayController> {
  let bus: MessageBus | undefined;
  let item: StatusNotifierItem | undefined;
  let menu: DbusMenu | undefined;
  let running = false;
  let stopped = false;
  const reportError = (error: unknown): void => options.onError?.(errorFrom(error));

  const controller: TrayController = {
    get running(): boolean { return running; },
    async update(): Promise<void> {
      if (!running || !menu || !item) return;
      try {
        const state = await menu.update();
        item.setEnabled(state.enabled);
        item.NewStatus(state.enabled ? "Active" : "Passive");
      } catch (error) {
        reportError(error);
      }
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      running = false;
      if (!bus) return;
      try {
        if (item) bus.unexport(ITEM_PATH, item);
        if (menu) bus.unexport(MENU_PATH, menu);
        await bus.releaseName(BUS_NAME);
      } catch (error) {
        reportError(error);
      } finally {
        bus.disconnect();
      }
    },
  };

  try {
    bus = sessionBus();
    // The library emits connection errors at runtime although its event-map type omits `error`.
    (bus as unknown as { on(event: "error", listener: (error: Error) => void): void }).on("error", reportError);
    menu = new DbusMenu(options, reportError);
    item = new StatusNotifierItem(options.title ?? "PipeQ", options.iconName ?? "", () => controller.update());
    bus.export(ITEM_PATH, item);
    bus.export(MENU_PATH, menu);
    await bus.requestName(BUS_NAME);
    running = true;
    await controller.update();
    await registerWithWatcher(bus, reportError);
  } catch (error) {
    reportError(error);
    await controller.stop();
  }

  return controller;
}
