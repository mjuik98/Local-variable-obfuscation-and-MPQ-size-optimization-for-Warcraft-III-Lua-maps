using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace WarcraftLuaProtectorDesktop
{
    internal sealed class PresetItem
    {
        public string Id;
        public string Label;
        public string Description;
        public bool CheckOnly;
        public bool RequiresCleanupContract;
        public override string ToString() { return Label; }
    }

    internal sealed class AdvancedSettingsForm : Form
    {
        private CheckBox minify, rename, renameGlobals, renameFields, hideNatives, cleanEditor, cleanDevelopment, compress;
        private CheckBox disableVm;
        private ComboBox nameMode, stringMode, sectorSize;
        private TextBox seed;
        private CheckedListBox levels, strategies;
        private DataGridView locals, globals, strings, files, exclusions, vmFunctions;
        private static readonly string[] StrategyIds = { "default", "filtered", "huffman-only", "rle", "fixed" };
        public Dictionary<string, object> Overrides { get; private set; }
        public bool NoVm { get; private set; }

        public AdvancedSettingsForm(IDictionary<string, object> effective, IDictionary<string, object> extra) : this(effective, extra, false) { }
        public AdvancedSettingsForm(IDictionary<string, object> effective, IDictionary<string, object> extra, bool noVm)
        {
            Text = "고급 설정"; Font = new Font("맑은 고딕", 9F); AutoScaleMode = AutoScaleMode.Font;
            ClientSize = new Size(840, 880); MinimumSize = new Size(800, 820); StartPosition = FormStartPosition.CenterParent;
            TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(14), ColumnCount = 1, RowCount = 6 };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 68)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 120)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 148));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 152)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48)); Controls.Add(layout);
            layout.Controls.Add(new Label { Text = "여기서 적용한 옵션은 프리셋과 설정 JSON보다 우선합니다.\r\n목록은 JSON의 기존 항목에 추가됩니다. VM 해제는 JSON의 선택 목록도 비웁니다.\r\n시드 이름 · 런타임 문자열 · VM · 전역/필드 이름 · 엔진 함수 숨김 · 섹터 크기는 실험 옵션이며 실제 게임 검증이 필요합니다.", Dock = DockStyle.Fill }, 0, 0);
            FlowLayoutPanel flags = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = true };
            minify = Flag("Lua 주석 · 공백 정리", EnabledValue(effective, "lua", "minify"));
            rename = Flag("local 이름 변경", EnabledValue(effective, "lua", "renameLocals"));
            renameGlobals = Flag("전역 이름 변경 (실험)", EnabledValue(effective, "lua", "renameGlobals"));
            renameFields = Flag("닫힌 테이블 필드 이름 변경 (실험)", EnabledValue(effective, "lua", "renameFields"));
            hideNatives = Flag("엔진 함수 호출 숨김 (실험)", EnabledValue(effective, "lua", "hideNatives"));
            cleanEditor = Flag("에디터 파일 정리", EnabledValue(effective, "cleanup", "editor"));
            cleanDevelopment = Flag("개발 파일 정리", EnabledValue(effective, "cleanup", "development"));
            compress = Flag("파일 재압축", EnabledValue(effective, "compression", "enabled"));
            foreach (CheckBox check in new CheckBox[] { minify, rename, renameGlobals, renameFields, hideNatives, cleanEditor, cleanDevelopment, compress }) flags.Controls.Add(check);
            flags.Controls.Add(new Label { Text = "Preloader를 사용하는 맵은 정리할 때 입력에 맞는 검토 계약이 필요합니다.\r\n메인 작업 화면의 검토 계약 → 찾아보기에서 선택하세요. 계약이 없으면 정리 옵션을 해제하세요.", AutoSize = true, MaximumSize = new Size(750, 0), Margin = new Padding(4, 8, 4, 0) }); layout.Controls.Add(flags, 0, 1);
            TableLayoutPanel transforms = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 4 };
            transforms.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90)); transforms.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); transforms.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90)); transforms.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            for (int i = 0; i < 4; i++) transforms.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
            nameMode = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill }; nameMode.Items.AddRange(new object[] { "짧은 이름 (compact)", "시드 기반 (seeded · 실험)" }); nameMode.SelectedIndex = Convert.ToString(SectionValue(effective, "lua", "nameMode")) == "seeded" ? 1 : 0;
            stringMode = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill }; stringMode.Items.AddRange(new object[] { "바이트 표기 (escape)", "런타임 복원 (runtime · 실험)" }); stringMode.SelectedIndex = Convert.ToString(SectionValue(effective, "strings", "mode")) == "runtime" ? 1 : 0;
            transforms.Controls.Add(new Label { Text = "이름 모드", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 0); transforms.Controls.Add(nameMode, 1, 0); transforms.Controls.Add(new Label { Text = "문자열 모드", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 2, 0); transforms.Controls.Add(stringMode, 3, 0);
            seed = new TextBox { Dock = DockStyle.Fill, MaxLength = 128, Text = Convert.ToString(SectionValue(effective, "lua", "seed")) }; if (seed.Text.Length == 0) seed.Text = "warcraft-lua-protector";
            transforms.Controls.Add(new Label { Text = "재현 시드", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 1); transforms.Controls.Add(seed, 1, 1); transforms.SetColumnSpan(seed, 3);
            disableVm = Flag("VM 해제 (JSON의 함수 선택 목록도 비움)", noVm); disableVm.Margin = new Padding(0, 4, 0, 0); transforms.Controls.Add(disableVm, 0, 2); transforms.SetColumnSpan(disableVm, 4);
            sectorSize = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
            sectorSize.Items.Add("입력 섹터 크기 유지"); for (int shift = 3; shift <= 8; shift++) sectorSize.Items.Add((512 << shift) / 1024 + " KiB (shift " + shift + " · 실험 · 전체 재압축)");
            object selectedShift = SectionValue(effective, "compression", "sectorSizeShift"); sectorSize.SelectedIndex = selectedShift == null ? 0 : Math.Max(0, Math.Min(6, Convert.ToInt32(selectedShift) - 2));
            transforms.Controls.Add(new Label { Text = "MPQ 섹터", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 3); transforms.Controls.Add(sectorSize, 1, 3); transforms.SetColumnSpan(sectorSize, 3); layout.Controls.Add(transforms, 0, 2);
            TableLayoutPanel compression = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
            compression.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 40)); compression.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 60));
            GroupBox levelGroup = new GroupBox { Text = "압축 레벨 후보 (하나 이상)", Dock = DockStyle.Fill };
            levels = new CheckedListBox { Dock = DockStyle.Fill, CheckOnClick = true, MultiColumn = true, ColumnWidth = 65, BorderStyle = BorderStyle.None };
            for (int i = 0; i <= 9; i++) levels.Items.Add(i, Contains(SectionValue(effective, "compression", "levels"), i)); levelGroup.Controls.Add(levels); compression.Controls.Add(levelGroup, 0, 0);
            GroupBox strategyGroup = new GroupBox { Text = "압축 전략 후보 (많을수록 시간이 늘어납니다)", Dock = DockStyle.Fill };
            strategies = new CheckedListBox { Dock = DockStyle.Fill, CheckOnClick = true, BorderStyle = BorderStyle.None };
            string[] labels = { "기본 (default)", "필터 (filtered)", "허프만 전용 (huffman-only)", "반복 데이터 (rle)", "고정 허프만 (fixed)" };
            object selectedStrategies = SectionValue(effective, "compression", "strategies");
            for (int i = 0; i < StrategyIds.Length; i++) strategies.Items.Add(labels[i], selectedStrategies == null ? i == 0 : Contains(selectedStrategies, StrategyIds[i]));
            strategyGroup.Controls.Add(strategies); compression.Controls.Add(strategyGroup, 1, 0); layout.Controls.Add(compression, 0, 3);
            TabControl lists = new TabControl { Dock = DockStyle.Fill };
            locals = AddList(lists, "local 이름", "추가로 이름을 유지할 Lua local 식별자", SectionValue(extra, "lua", "keepLocals"));
            globals = AddList(lists, "전역 이름", "전역 이름 변경에서 추가로 유지할 Lua 전역 식별자", SectionValue(extra, "lua", "keepGlobals"));
            strings = AddList(lists, "문자열", "추가로 숨기지 않을 실제 문자열 값 (공백 · 빈 값도 그대로 보존)", SectionValue(extra, "strings", "keep"), true);
            files = AddList(lists, "파일 보존", "정리에서 제외할 추가 MPQ 파일 경로", SectionValue(extra, "cleanup", "keepFiles"));
            exclusions = AddList(lists, "재압축 제외", "재압축에서 제외할 추가 MPQ 파일 경로", SectionValue(extra, "compression", "excludeFiles"));
            vmFunctions = AddList(lists, "VM 함수 (실험)", "검토한 local 계산 함수의 원본 이름만 직접 지정 (실험 · 게임 검증 필요)", SectionValue(extra, "lua", "vmFunctions")); vmFunctions.Enabled = !disableVm.Checked; disableVm.CheckedChanged += delegate { vmFunctions.Enabled = !disableVm.Checked; }; layout.Controls.Add(lists, 0, 4);
            FlowLayoutPanel buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 8, 0, 0) };
            Button apply = new Button { Text = "적용", Width = 100, Height = 32 }; Button cancel = new Button { Text = "닫기", Width = 100, Height = 32, DialogResult = DialogResult.Cancel };
            Button reset = new Button { Text = "고급 설정 해제", Width = 140, Height = 32 };
            apply.Click += delegate { try { Overrides = ReadOverrides(); NoVm = disableVm.Checked; DialogResult = DialogResult.OK; Close(); } catch (ArgumentException error) { MessageBox.Show(this, error.Message, "고급 설정", MessageBoxButtons.OK, MessageBoxIcon.Warning); } };
            reset.Click += delegate { Overrides = new Dictionary<string, object>(); NoVm = false; DialogResult = DialogResult.OK; Close(); };
            buttons.Controls.Add(apply); buttons.Controls.Add(cancel); buttons.Controls.Add(reset); layout.Controls.Add(buttons, 0, 5); AcceptButton = apply; CancelButton = cancel;
        }
        private static CheckBox Flag(string text, bool value) { return new CheckBox { Text = text, Checked = value, AutoSize = true, Margin = new Padding(4, 8, 18, 4) }; }
        private static object SectionValue(IDictionary<string, object> value, string section, string key)
        {
            object group, result; IDictionary<string, object> nested;
            return value != null && value.TryGetValue(section, out group) && (nested = group as IDictionary<string, object>) != null && nested.TryGetValue(key, out result) ? result : null;
        }
        private static bool EnabledValue(IDictionary<string, object> value, string section, string key) { object selected = SectionValue(value, section, key); return selected is bool && (bool)selected; }
        private static bool Contains(object values, object target) { IList list = values as IList; if (list == null) return false; foreach (object value in list) if (Convert.ToString(value) == Convert.ToString(target)) return true; return false; }
        private static DataGridView AddList(TabControl tabs, string title, string caption, object values, bool allowEmpty = false)
        {
            TabPage page = new TabPage(title); TableLayoutPanel panel = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = allowEmpty ? 3 : 2, ColumnCount = 1, Padding = new Padding(6) };
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 38)); panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); panel.Controls.Add(new Label { Text = caption + "\r\n한 행에 한 항목 · 선택 행은 Delete로 삭제", Dock = DockStyle.Fill }, 0, 0);
            DataGridView grid = new DataGridView { Dock = DockStyle.Fill, AllowUserToAddRows = true, AllowUserToDeleteRows = true, RowHeadersWidth = 28, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells, BackgroundColor = Color.White };
            grid.Columns.Add("value", "값"); grid.DefaultCellStyle.WrapMode = DataGridViewTriState.True; IList list = values as IList;
            if (list != null) foreach (object value in list) grid.Rows.Add(new object[] { Convert.ToString(value) });
            if (allowEmpty) { panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 34)); Button empty = new Button { Text = "빈 문자열 추가", Width = 130, Height = 28 }; empty.Click += delegate { grid.Rows.Add(new object[] { "" }); }; panel.Controls.Add(empty, 0, 2); }
            panel.Controls.Add(grid, 0, 1); page.Controls.Add(panel); tabs.TabPages.Add(page); return grid;
        }
        private static string[] Values(DataGridView grid, bool exact)
        {
            grid.EndEdit(); List<string> values = new List<string>();
            foreach (DataGridViewRow row in grid.Rows) { if (row.IsNewRow) continue; string value = Convert.ToString(row.Cells[0].Value); if (!exact && value.Length == 0) continue; values.Add(value); }
            return values.ToArray();
        }
        private Dictionary<string, object> ReadOverrides()
        {
            if (levels.CheckedItems.Count == 0 || strategies.CheckedItems.Count == 0) throw new ArgumentException("압축 레벨과 전략을 각각 하나 이상 선택하세요.");
            if (seed.Text.Length == 0 || seed.Text.Length > 128) throw new ArgumentException("시드는 1~128자의 문자열이어야 합니다.");
            for (int i = 0; i < seed.Text.Length; i++) { char value = seed.Text[i]; if (Char.IsControl(value) || value == '\u2028' || value == '\u2029') throw new ArgumentException("시드에 제어 문자나 줄 구분 문자를 사용할 수 없습니다."); if (Char.IsHighSurrogate(value)) { if (i + 1 >= seed.Text.Length || !Char.IsLowSurrogate(seed.Text[++i])) throw new ArgumentException("시드의 유니코드 문자열이 올바르지 않습니다."); } else if (Char.IsLowSurrogate(value)) throw new ArgumentException("시드의 유니코드 문자열이 올바르지 않습니다."); }
            string[] keptLocals = Values(locals, false), keptGlobals = Values(globals, false), selectedVm = Values(vmFunctions, false), keptStrings = Values(strings, true), keptFiles = Values(files, false), excludedFiles = Values(exclusions, false);
            foreach (string value in keptLocals) ValidateIdentifier(value); foreach (string value in keptGlobals) ValidateIdentifier(value); foreach (string value in selectedVm) ValidateIdentifier(value);
            if (sectorSize.SelectedIndex > 0 && (!compress.Checked || excludedFiles.Length > 0)) throw new ArgumentException("섹터 크기 변경은 모든 파일을 다시 압축합니다. 파일 재압축을 켜고 재압축 제외 목록을 비우세요.");
            foreach (string value in keptStrings) if (!WellFormed(value)) throw new ArgumentException("보존 문자열의 유니코드가 올바르지 않습니다.");
            foreach (string value in keptFiles) ValidateMpqPath(value); foreach (string value in excludedFiles) ValidateMpqPath(value);
            List<int> chosenLevels = new List<int>(); foreach (object value in levels.CheckedItems) chosenLevels.Add(Convert.ToInt32(value));
            List<string> chosenStrategies = new List<string>(); for (int i = 0; i < strategies.Items.Count; i++) if (strategies.GetItemChecked(i)) chosenStrategies.Add(StrategyIds[i]);
            return new Dictionary<string, object> {
                { "lua", new Dictionary<string, object> { { "minify", minify.Checked }, { "renameLocals", rename.Checked }, { "keepLocals", keptLocals }, { "nameMode", nameMode.SelectedIndex == 1 ? "seeded" : "compact" }, { "seed", seed.Text }, { "vmFunctions", selectedVm },
                    { "renameGlobals", renameGlobals.Checked }, { "renameFields", renameFields.Checked }, { "hideNatives", hideNatives.Checked }, { "keepGlobals", keptGlobals } } },
                { "strings", new Dictionary<string, object> { { "keep", keptStrings }, { "mode", stringMode.SelectedIndex == 1 ? "runtime" : "escape" } } },
                { "cleanup", new Dictionary<string, object> { { "editor", cleanEditor.Checked }, { "development", cleanDevelopment.Checked }, { "keepFiles", keptFiles } } },
                { "compression", new Dictionary<string, object> { { "enabled", compress.Checked }, { "levels", chosenLevels.ToArray() }, { "strategies", chosenStrategies.ToArray() }, { "excludeFiles", excludedFiles }, { "sectorSizeShift", sectorSize.SelectedIndex == 0 ? null : (object)(sectorSize.SelectedIndex + 2) } } }
            };
        }
        private static void ValidateIdentifier(string value) { if (!System.Text.RegularExpressions.Regex.IsMatch(value, "^[A-Za-z_][A-Za-z0-9_]*$")) throw new ArgumentException("local · 전역 · VM 함수 이름은 원본 Lua 식별자여야 합니다: " + value); }
        private static void ValidateMpqPath(string value) { foreach (char character in value) if (character < 0x20 || character > 0x7e) throw new ArgumentException("MPQ 파일 경로에는 인쇄 가능한 ASCII 문자만 사용할 수 있습니다: " + value); }
        private static bool WellFormed(string value) { for (int i = 0; i < value.Length; i++) { if (Char.IsHighSurrogate(value[i])) { if (i + 1 >= value.Length || !Char.IsLowSurrogate(value[++i])) return false; } else if (Char.IsLowSurrogate(value[i])) return false; } return true; }
    }

    internal sealed class ProtectorForm : Form
    {
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private readonly string applicationDirectory = AppDomain.CurrentDomain.BaseDirectory;
        private TextBox inputPath;
        private TextBox outputPath;
        private TextBox configurationPath;
        private TextBox cleanupContractPath;
        private TextBox previousInputPath;
        private TextBox previousContractPath;
        private TextBox resultText;
        private ComboBox presetBox;
        private CheckBox hideStrings;
        private Label presetDescription;
        private Label statusLabel;
        private Label reviewHint;
        private ProgressBar progress;
        private Button checkButton;
        private Button protectButton;
        private Button cancelButton;
        private Button compareButton;
        private Button saveContractButton;
        private Button settingsButton, advancedButton, combinationsButton, applyCombinationButton;
        private DataGridView savingsGrid, combinationsGrid;
        private TabControl resultTabs;
        private IDictionary<string, object> effectiveConfiguration;
        private Dictionary<string, object> advancedOverrides = new Dictionary<string, object>();
        private bool editAdvancedAfterSettings, lastCacheReused;
        private bool noVm, loadingPresets;
        private string lastPresetId;
        private GroupBox inputGroup;
        private TabControl tabs;
        private Process process;
        private StreamWriter processInput;
        private string action;
        private bool busy;
        private bool receivedResult;
        private bool closeRequested;
        private bool cancelRequested;
        private bool automatedMode;
        private bool operationSucceeded;
        private bool reviewEligible;
        private string reviewedInput;
        private string reviewedPreviousInput;
        private string reviewedContract;
        private readonly StringBuilder processErrors = new StringBuilder();

        public ProtectorForm()
        {
            Text = "Warcraft Lua Protector";
            ClientSize = new Size(980, 800);
            MinimumSize = new Size(920, 760);
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Font;
            Font = new Font("맑은 고딕", 9F);
            BackColor = Color.FromArgb(246, 248, 251);
            serializer.MaxJsonLength = 8 * 1024 * 1024;
            serializer.RecursionLimit = 128;
            BuildControls();
            AddFallbackPresets();
            UpdateAvailability();
            Shown += delegate { if (!automatedMode) StartBackend(new Dictionary<string, object> { { "action", "presets" } }); };
        }

        private void BuildControls()
        {
            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Padding = new Padding(18, 12, 18, 10);
            layout.ColumnCount = 1;
            layout.RowCount = 6;
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 74));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 82));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 300));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
            Controls.Add(layout);

            Panel header = new Panel { Dock = DockStyle.Fill };
            Label title = new Label { Text = "Lua 맵 보호 · 최적화", AutoSize = true, Location = new Point(0, 2), Font = new Font("맑은 고딕", 20F, FontStyle.Bold), ForeColor = Color.FromArgb(28, 45, 72) };
            Label subtitle = new Label { Text = "입력 맵을 검사한 뒤 별도의 배포 사본을 만듭니다.", AutoSize = true, Location = new Point(2, 48), ForeColor = Color.FromArgb(85, 96, 114) };
            header.Controls.Add(title); header.Controls.Add(subtitle);
            layout.Controls.Add(header, 0, 0);

            inputGroup = new GroupBox { Text = "입력 맵", Dock = DockStyle.Fill, Padding = new Padding(10, 7, 10, 7) };
            TableLayoutPanel inputRows = PathTable();
            inputRows.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
            inputPath = PathBox();
            AddPathRow(inputRows, 0, "현재 Lua 맵", inputPath, "찾아보기", delegate {
                string selected = OpenFile("Warcraft III 맵|*.w3x;*.w3m|모든 파일|*.*");
                if (selected == null) return;
                inputPath.Text = selected;
                if (String.IsNullOrWhiteSpace(outputPath.Text)) outputPath.Text = DefaultOutput(selected);
            });
            inputGroup.Controls.Add(inputRows); layout.Controls.Add(inputGroup, 0, 1);

            tabs = new TabControl { Dock = DockStyle.Fill, Padding = new Point(16, 7) };
            TabPage protectPage = new TabPage("보호 · 배포") { BackColor = Color.White, Padding = new Padding(10, 6, 10, 8) };
            TabPage reviewPage = new TabPage("검토 계약 비교") { BackColor = Color.White, Padding = new Padding(10, 6, 10, 8) };
            tabs.TabPages.Add(protectPage); tabs.TabPages.Add(reviewPage); layout.Controls.Add(tabs, 0, 2);

            TableLayoutPanel protectRows = PathTable();
            foreach (int height in new int[] { 34, 42, 34, 34, 34, 40, 24 }) protectRows.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
            presetBox = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList, Margin = new Padding(4, 4, 4, 3) };
            protectRows.Controls.Add(FieldLabel("작업 프리셋"), 0, 0); protectRows.Controls.Add(presetBox, 1, 0); protectRows.SetColumnSpan(presetBox, 2);
            presetDescription = new Label { Dock = DockStyle.Fill, ForeColor = Color.FromArgb(72, 83, 99), Padding = new Padding(4, 4, 4, 0) };
            protectRows.Controls.Add(presetDescription, 0, 1); protectRows.SetColumnSpan(presetDescription, 3);
            outputPath = PathBox(); configurationPath = PathBox(); cleanupContractPath = PathBox();
            AddPathRow(protectRows, 2, "배포 사본", outputPath, "저장 경로", delegate {
                string selected = SaveFile("Warcraft III 맵|*.w3x;*.w3m", String.IsNullOrWhiteSpace(outputPath.Text) ? DefaultOutput(inputPath.Text) : outputPath.Text);
                if (selected != null) outputPath.Text = selected;
            });
            AddPathRow(protectRows, 3, "설정 JSON", configurationPath, "찾아보기", delegate { BrowseJson(configurationPath); });
            AddPathRow(protectRows, 4, "검토 계약", cleanupContractPath, "찾아보기", delegate { BrowseJson(cleanupContractPath); });
            FlowLayoutPanel settingActions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(4, 3, 0, 0) };
            hideStrings = new CheckBox { Text = "선택적 문자열 숨김", AutoSize = true, Margin = new Padding(0, 8, 20, 0) };
            advancedButton = ActionButton("고급 설정", 110, false); settingsButton = ActionButton("적용 설정 확인", 140, false);
            advancedButton.Click += delegate { editAdvancedAfterSettings = true; StartSettings(); }; settingsButton.Click += delegate { editAdvancedAfterSettings = false; StartSettings(); };
            settingActions.Controls.Add(hideStrings); settingActions.Controls.Add(advancedButton); settingActions.Controls.Add(settingsButton);
            protectRows.Controls.Add(settingActions, 0, 5); protectRows.SetColumnSpan(settingActions, 3);
            Label priority = new Label { Text = "문자열 선택과 고급 설정은 JSON보다 우선합니다. 동적 파일 참조가 있으면 정리 전에 검토 계약을 선택하세요.", Dock = DockStyle.Fill, ForeColor = Color.FromArgb(100, 110, 125), Font = new Font("맑은 고딕", 8.5F), Padding = new Padding(4, 0, 0, 0) };
            protectRows.Controls.Add(priority, 0, 6); protectRows.SetColumnSpan(priority, 3);
            protectPage.Controls.Add(protectRows);

            TableLayoutPanel reviewRows = PathTable();
            foreach (int height in new int[] { 48, 36, 36, 48, 74 }) reviewRows.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
            Label reviewIntro = new Label { Text = "이전 입력 맵과 그 맵의 검토 계약을 현재 입력 맵과 비교합니다. 내용이 그대로이고 재포장만 된 경우에 새 계약을 저장할 수 있습니다.", Dock = DockStyle.Fill, Padding = new Padding(4, 3, 4, 0), ForeColor = Color.FromArgb(72, 83, 99) };
            reviewRows.Controls.Add(reviewIntro, 0, 0); reviewRows.SetColumnSpan(reviewIntro, 3);
            previousInputPath = PathBox(); previousContractPath = PathBox();
            AddPathRow(reviewRows, 1, "이전 입력 맵", previousInputPath, "찾아보기", delegate {
                string selected = OpenFile("Warcraft III 맵|*.w3x;*.w3m|모든 파일|*.*"); if (selected != null) previousInputPath.Text = selected;
            });
            AddPathRow(reviewRows, 2, "이전 검토 계약", previousContractPath, "찾아보기", delegate { BrowseJson(previousContractPath); });
            FlowLayoutPanel reviewActions = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(4, 6, 0, 0), WrapContents = false };
            compareButton = ActionButton("입력 · 계약 비교", 155, false);
            saveContractButton = ActionButton("새 검토 계약 저장", 170, false);
            compareButton.Click += delegate { StartReview(false); }; saveContractButton.Click += delegate { StartReview(true); };
            reviewActions.Controls.Add(compareButton); reviewActions.Controls.Add(saveContractButton);
            reviewRows.Controls.Add(reviewActions, 1, 3); reviewRows.SetColumnSpan(reviewActions, 2);
            reviewHint = new Label { Text = "비교를 먼저 실행하세요. 새 계약을 저장할 때 입력을 다시 비교하며 기존 계약 파일은 덮어쓰지 않습니다.", Dock = DockStyle.Fill, Padding = new Padding(4, 5, 4, 0), ForeColor = Color.FromArgb(100, 110, 125) };
            reviewRows.Controls.Add(reviewHint, 0, 4); reviewRows.SetColumnSpan(reviewHint, 3); reviewPage.Controls.Add(reviewRows);

            FlowLayoutPanel actions = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 8, 0, 0), WrapContents = false };
            checkButton = ActionButton("맵 검사", 125, false);
            protectButton = ActionButton("배포 사본 저장", 160, true);
            cancelButton = ActionButton("취소", 90, false);
            combinationsButton = ActionButton("설정 조합 비교", 150, false);
            checkButton.Click += delegate { StartProtection("check"); }; protectButton.Click += delegate { StartProtection("protect"); }; cancelButton.Click += delegate { RequestCancel(); };
            combinationsButton.Click += delegate { StartCombinations(); };
            actions.Controls.Add(checkButton); actions.Controls.Add(protectButton); actions.Controls.Add(combinationsButton); actions.Controls.Add(cancelButton); layout.Controls.Add(actions, 0, 3);
            AcceptButton = checkButton;

            GroupBox resultGroup = new GroupBox { Text = "처리 결과", Dock = DockStyle.Fill, Padding = new Padding(10, 5, 10, 8) };
            TableLayoutPanel resultRows = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 };
            resultRows.RowStyles.Add(new RowStyle(SizeType.Absolute, 28)); resultRows.RowStyles.Add(new RowStyle(SizeType.Absolute, 17)); resultRows.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            statusLabel = new Label { Text = "입력 맵과 작업 프리셋을 선택하세요.", Dock = DockStyle.Fill, ForeColor = Color.FromArgb(40, 58, 82), Padding = new Padding(0, 4, 0, 0), AutoEllipsis = true };
            progress = new ProgressBar { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, 4), Style = ProgressBarStyle.Continuous };
            resultText = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BackColor = Color.White, BorderStyle = BorderStyle.FixedSingle, Text = "검사는 전체 변환을 메모리에서 확인하며 맵을 저장하지 않습니다.\r\n배포 사본은 검증한 뒤 새로운 경로에만 저장합니다." };
            resultTabs = new TabControl { Dock = DockStyle.Fill };
            TabPage summaryPage = new TabPage("요약") { Padding = new Padding(3) }; summaryPage.Controls.Add(resultText);
            TabPage savingsPage = new TabPage("파일별 절감") { Padding = new Padding(3) };
            savingsGrid = ResultsGrid(); AddColumn(savingsGrid, "name", "파일", 280); AddColumn(savingsGrid, "kind", "처리", 120); AddColumn(savingsGrid, "before", "이전", 120); AddColumn(savingsGrid, "after", "이후", 120); AddColumn(savingsGrid, "saved", "절감", 120); AddColumn(savingsGrid, "percent", "절감률", 80); savingsPage.Controls.Add(savingsGrid);
            TabPage combinationsPage = new TabPage("조합 비교") { Padding = new Padding(3) };
            TableLayoutPanel combinationRows = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1 }; combinationRows.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); combinationRows.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
            combinationsGrid = ResultsGrid(); AddColumn(combinationsGrid, "label", "설정 조합", 230); AddColumn(combinationsGrid, "ok", "결과", 65); AddColumn(combinationsGrid, "size", "결과 크기", 105); AddColumn(combinationsGrid, "saved", "절감", 105); AddColumn(combinationsGrid, "percent", "절감률", 75); AddColumn(combinationsGrid, "time", "검사 시간", 85); AddColumn(combinationsGrid, "error", "거부 원인", 300);
            combinationsGrid.SelectionChanged += delegate { UpdateAvailability(); };
            FlowLayoutPanel choose = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 5, 0, 0), WrapContents = false };
            applyCombinationButton = ActionButton("선택한 조합 적용", 165, false); applyCombinationButton.Click += delegate { ApplyCombination(); };
            choose.Controls.Add(applyCombinationButton); choose.Controls.Add(new Label { Text = "현재 설정은 JSON · 고급 설정을 포함하며 나머지는 기본 프리셋입니다.", AutoSize = true, Margin = new Padding(0, 8, 0, 0) }); combinationRows.Controls.Add(combinationsGrid, 0, 0); combinationRows.Controls.Add(choose, 0, 1); combinationsPage.Controls.Add(combinationRows);
            resultTabs.TabPages.Add(summaryPage); resultTabs.TabPages.Add(savingsPage); resultTabs.TabPages.Add(combinationsPage);
            resultRows.Controls.Add(statusLabel, 0, 0); resultRows.Controls.Add(progress, 0, 1); resultRows.Controls.Add(resultTabs, 0, 2); resultGroup.Controls.Add(resultRows); layout.Controls.Add(resultGroup, 0, 4);
            Label footer = new Label { Text = "원본은 읽기만 하며 기존 출력 파일은 덮어쓰지 않습니다. 실제 게임 실행 · 멀티플레이 · 성능 확인은 별도로 필요합니다.", Dock = DockStyle.Fill, ForeColor = Color.FromArgb(100, 110, 125), Font = new Font("맑은 고딕", 8.5F), Padding = new Padding(0, 8, 0, 0) };
            layout.Controls.Add(footer, 0, 5);

            presetBox.SelectedIndexChanged += delegate { PresetItem selected = SelectedPreset(); if (!loadingPresets && selected != null && selected.Id != lastPresetId) { lastPresetId = selected.Id; hideStrings.Checked = selected.Id == "hardened"; } InvalidateConfiguration(); UpdateAvailability(); };
            inputPath.TextChanged += delegate { InvalidateReview(); InvalidateCombinations(); UpdateAvailability(); };
            configurationPath.TextChanged += delegate { InvalidateConfiguration(); UpdateAvailability(); };
            cleanupContractPath.TextChanged += delegate { InvalidateCombinations(); UpdateAvailability(); };
            hideStrings.CheckedChanged += delegate { InvalidateConfiguration(); UpdateAvailability(); };
            previousInputPath.TextChanged += delegate { InvalidateReview(); UpdateAvailability(); };
            previousContractPath.TextChanged += delegate { InvalidateReview(); UpdateAvailability(); };
        }

        private static TableLayoutPanel PathTable()
        {
            TableLayoutPanel rows = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, Margin = new Padding(0) };
            rows.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 116)); rows.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); rows.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96));
            return rows;
        }
        private static TextBox PathBox() { return new TextBox { Dock = DockStyle.Fill, Margin = new Padding(4, 5, 4, 3) }; }
        private static Label FieldLabel(string text) { return new Label { Text = text, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(4, 0, 0, 0) }; }
        private static DataGridView ResultsGrid()
        {
            return new DataGridView { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false, AllowUserToDeleteRows = false, AllowUserToResizeRows = false, RowHeadersVisible = false, SelectionMode = DataGridViewSelectionMode.FullRowSelect, MultiSelect = false, BackgroundColor = Color.White, AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells };
        }
        private static void AddColumn(DataGridView grid, string id, string title, int width) { int index = grid.Columns.Add(id, title); grid.Columns[index].Width = width; grid.Columns[index].SortMode = DataGridViewColumnSortMode.NotSortable; }
        private static Button ActionButton(string text, int width, bool primary)
        {
            Button button = new Button { Text = text, Width = width, Height = 34, Margin = new Padding(0, 0, 10, 0), FlatStyle = FlatStyle.Flat, BackColor = primary ? Color.FromArgb(34, 88, 157) : Color.White, ForeColor = primary ? Color.White : Color.FromArgb(40, 58, 82) };
            button.FlatAppearance.BorderColor = primary ? button.BackColor : Color.FromArgb(192, 201, 214);
            return button;
        }
        private void AddPathRow(TableLayoutPanel rows, int row, string label, TextBox field, string buttonText, EventHandler clicked)
        {
            rows.Controls.Add(FieldLabel(label), 0, row); rows.Controls.Add(field, 1, row);
            Button button = new Button { Text = buttonText, Dock = DockStyle.Fill, Margin = new Padding(4, 3, 0, 3) }; button.Click += clicked; rows.Controls.Add(button, 2, row);
        }
        private void AddFallbackPresets()
        {
            presetBox.Items.Add(new PresetItem { Id = "fast-check", Label = "빠른 검사", Description = "Lua 원문과 파일을 보존하며 전체 변환을 검사합니다. 결과 맵은 저장하지 않습니다.", CheckOnly = true });
            presetBox.Items.Add(new PresetItem { Id = "size", Label = "용량 최적화", Description = "Lua 원문과 파일을 보존하고 압축 후보 중 작은 결과를 선택합니다." });
            presetBox.Items.Add(new PresetItem { Id = "protect", Label = "기본 보호", Description = "Lua 주석·공백 정리와 local 이름 변경을 적용합니다. 파일 정리는 기본적으로 끕니다." });
            presetBox.Items.Add(new PresetItem { Id = "distribution", Label = "배포 준비", Description = "Lua 기본 보호와 알려진 에디터·개발 파일 정리를 적용합니다. 파일 정리를 켜면 검토 계약이 필요합니다.", RequiresCleanupContract = true });
            presetBox.Items.Add(new PresetItem { Id = "hardened", Label = "보호 강화", Description = "시드 이름과 런타임 문자열 복원을 적용합니다. VM 함수는 직접 지정하며 게임 검증이 필요한 실험 옵션입니다. 파일 정리는 기본적으로 끕니다." });
            presetBox.Items.Add(new PresetItem { Id = "maximum", Label = "최대 보호", Description = "보호 강화에 더해 전역·닫힌 테이블 필드 이름 변경과 엔진 함수 호출 숨김을 적용합니다. 게임 검증이 필요한 실험 옵션입니다." });
            presetBox.SelectedIndex = 2;
        }
        private PresetItem SelectedPreset() { return presetBox.SelectedItem as PresetItem; }
        private void UpdateAvailability()
        {
            PresetItem selected = SelectedPreset();
            if (presetDescription != null) presetDescription.Text = selected == null ? "작업 프리셋을 선택하세요." : selected.Description;
            if (checkButton == null) return;
            bool hasInput = !String.IsNullOrWhiteSpace(inputPath.Text);
            checkButton.Enabled = !busy && hasInput && selected != null;
            protectButton.Enabled = !busy && hasInput && selected != null && !selected.CheckOnly;
            cancelButton.Enabled = busy && !cancelRequested;
            compareButton.Enabled = !busy && hasInput && !String.IsNullOrWhiteSpace(previousInputPath.Text) && !String.IsNullOrWhiteSpace(previousContractPath.Text);
            saveContractButton.Enabled = !busy && reviewEligible && SamePath(reviewedInput, inputPath.Text) && SamePath(reviewedPreviousInput, previousInputPath.Text) && SamePath(reviewedContract, previousContractPath.Text);
            settingsButton.Enabled = !busy && selected != null; advancedButton.Enabled = !busy && selected != null;
            combinationsButton.Enabled = !busy && hasInput && selected != null;
            IDictionary<string, object> comparison = SelectedCombination();
            applyCombinationButton.Enabled = !busy && comparison != null && BoolValue(comparison, "ok") && Value(comparison, "config") is IDictionary<string, object>;
        }
        private static bool SamePath(string first, string second) { return String.Equals(first == null ? null : first.Trim(), second == null ? null : second.Trim(), StringComparison.OrdinalIgnoreCase); }
        private void InvalidateReview() { reviewEligible = false; }
        private void InvalidateConfiguration() { effectiveConfiguration = null; InvalidateCombinations(); }
        private void InvalidateCombinations() { if (combinationsGrid != null) combinationsGrid.Rows.Clear(); }
        private IDictionary<string, object> SelectedCombination() { return combinationsGrid != null && combinationsGrid.CurrentRow != null ? combinationsGrid.CurrentRow.Tag as IDictionary<string, object> : null; }
        private void SetBusy(bool value)
        {
            busy = value; inputGroup.Enabled = !value; tabs.Enabled = !value;
            progress.Style = value ? ProgressBarStyle.Marquee : ProgressBarStyle.Continuous;
            progress.MarqueeAnimationSpeed = value ? 25 : 0;
            if (value) progress.Value = 0;
            UpdateAvailability();
        }

        private string OpenFile(string filter)
        {
            using (OpenFileDialog dialog = new OpenFileDialog()) { dialog.Filter = filter; dialog.CheckFileExists = true; dialog.Multiselect = false; return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileName : null; }
        }
        private string SaveFile(string filter, string suggested)
        {
            using (SaveFileDialog dialog = new SaveFileDialog())
            {
                dialog.Filter = filter; dialog.OverwritePrompt = false; dialog.AddExtension = true;
                if (!String.IsNullOrWhiteSpace(suggested)) { dialog.FileName = Path.GetFileName(suggested); string parent = Path.GetDirectoryName(suggested); if (!String.IsNullOrWhiteSpace(parent) && Directory.Exists(parent)) dialog.InitialDirectory = parent; }
                if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                if (File.Exists(dialog.FileName) || Directory.Exists(dialog.FileName)) { ShowFailure("이미 존재하는 경로입니다. 기존 파일을 덮어쓰지 않도록 새로운 이름을 선택하세요."); return null; }
                return dialog.FileName;
            }
        }
        private void BrowseJson(TextBox field) { string selected = OpenFile("JSON 파일|*.json|모든 파일|*.*"); if (selected != null) field.Text = selected; }
        private static string DefaultOutput(string source)
        {
            if (String.IsNullOrWhiteSpace(source)) return "protected.w3x";
            try { return Path.Combine(Path.GetDirectoryName(source) ?? "", Path.GetFileNameWithoutExtension(source) + ".protected" + Path.GetExtension(source)); }
            catch (ArgumentException) { return "protected.w3x"; }
        }
        private static void OptionalPath(Dictionary<string, object> request, string key, string value) { if (!String.IsNullOrWhiteSpace(value)) request[key] = value.Trim(); }
        private Dictionary<string, object> SettingsRequest(string selectedAction)
        {
            Dictionary<string, object> request = new Dictionary<string, object> { { "action", selectedAction }, { "preset", SelectedPreset().Id }, { "hideStrings", hideStrings.Checked } };
            OptionalPath(request, "configPath", configurationPath.Text);
            if (advancedOverrides.Count > 0) request["overrides"] = advancedOverrides;
            if (noVm) request["noVm"] = true;
            return request;
        }
        private void StartSettings() { if (!busy && SelectedPreset() != null) StartBackend(SettingsRequest("settings")); }
        private void StartCombinations()
        {
            if (busy || SelectedPreset() == null || String.IsNullOrWhiteSpace(inputPath.Text)) return;
            Dictionary<string, object> request = SettingsRequest("compare"); request["input"] = inputPath.Text.Trim(); OptionalPath(request, "cleanupContractPath", cleanupContractPath.Text); StartBackend(request);
        }
        private void ApplyCombination()
        {
            IDictionary<string, object> comparison = SelectedCombination();
            if (busy || comparison == null || !BoolValue(comparison, "ok")) return;
            IDictionary<string, object> config = Value(comparison, "config") as IDictionary<string, object>; if (config == null) return;
            string label = TextValue(comparison, "label"), preset = TextValue(comparison, "preset");
            advancedOverrides = CloneConfig(config); noVm = false; configurationPath.Text = "";
            for (int i = 0; i < presetBox.Items.Count; i++) if (((PresetItem)presetBox.Items[i]).Id == preset) { presetBox.SelectedIndex = i; break; }
            hideStrings.Checked = BoolValue(comparison, "hideStrings"); InvalidateConfiguration(); UpdateAvailability();
            resultText.Text = "선택한 조합을 적용했습니다: " + label + "\r\n설정 JSON 경로를 비우고 선택한 최종 설정을 고급 설정으로 적용했습니다. 다음 검사에서 입력과 계약을 다시 확인합니다.";
            resultTabs.SelectedIndex = 0; statusLabel.Text = "선택한 조합이 다음 작업에 적용됩니다.";
        }
        private Dictionary<string, object> CloneConfig(IDictionary<string, object> config) { return serializer.DeserializeObject(serializer.Serialize(config)) as Dictionary<string, object>; }
        private void StartProtection(string selectedAction)
        {
            if (busy || SelectedPreset() == null) return;
            if (String.IsNullOrWhiteSpace(inputPath.Text)) { ShowFailure("입력 Lua 맵을 선택하세요."); return; }
            if (selectedAction == "protect" && SelectedPreset().CheckOnly) { ShowFailure("빠른 검사 프리셋은 결과 맵을 저장하지 않습니다. 저장할 작업 프리셋을 선택하세요."); return; }
            if (selectedAction == "protect" && String.IsNullOrWhiteSpace(outputPath.Text)) { ShowFailure("배포 사본을 저장할 새로운 경로를 선택하세요."); return; }
            Dictionary<string, object> request = SettingsRequest(selectedAction); request["input"] = inputPath.Text.Trim();
            if (selectedAction == "protect") OptionalPath(request, "output", outputPath.Text);
            OptionalPath(request, "cleanupContractPath", cleanupContractPath.Text);
            StartBackend(request);
        }
        private void StartReview(bool save)
        {
            if (busy) return;
            if (String.IsNullOrWhiteSpace(inputPath.Text) || String.IsNullOrWhiteSpace(previousInputPath.Text) || String.IsNullOrWhiteSpace(previousContractPath.Text)) { ShowFailure("현재 입력 맵, 이전 입력 맵과 이전 검토 계약을 선택하세요."); return; }
            Dictionary<string, object> request = new Dictionary<string, object> { { "action", save ? "save-contract" : "review" }, { "input", inputPath.Text.Trim() }, { "previousInput", previousInputPath.Text.Trim() }, { "cleanupContractPath", previousContractPath.Text.Trim() } };
            if (save)
            {
                if (!reviewEligible) return;
                string target = SaveFile("검토 계약 JSON|*.json", Path.Combine(Path.GetDirectoryName(inputPath.Text) ?? "", Path.GetFileNameWithoutExtension(inputPath.Text) + ".reviewed.json"));
                if (target == null) return;
                request["contractOutput"] = target;
            }
            StartBackend(request);
        }

        private void StartBackend(Dictionary<string, object> request)
        {
            if (busy || closeRequested) return;
            string node = Path.Combine(applicationDirectory, "runtime", "node.exe");
            string backend = Path.Combine(applicationDirectory, "src", "desktop.mjs");
            if (!File.Exists(node) || !File.Exists(backend)) { ShowFailure("동봉된 실행 파일을 찾을 수 없습니다. 압축 파일을 모두 풀고 같은 폴더의 프로그램을 실행하세요.\r\n필요한 파일: runtime\\node.exe, src\\desktop.mjs"); return; }
            if (process != null && (processInput == null || process.HasExited)) { ShowFailure("처리 세션이 종료되는 중입니다. 잠시 후 다시 실행하세요."); return; }
            action = Convert.ToString(request["action"]); receivedResult = false; operationSucceeded = false; lastCacheReused = false; cancelRequested = false; processErrors.Clear();
            if (action == "review" || action == "save-contract") { reviewedInput = Convert.ToString(request["input"]); reviewedPreviousInput = Convert.ToString(request["previousInput"]); reviewedContract = Convert.ToString(request["cleanupContractPath"]); reviewEligible = false; }
            statusLabel.Text = action == "presets" ? "작업 프리셋을 불러오는 중입니다." : "처리를 시작하는 중입니다.";
            if (action != "presets") resultText.Text = "";
            SetBusy(true);
            if (process != null)
            {
                try { processInput.WriteLine(serializer.Serialize(request)); }
                catch (Exception error) { CloseSessionInput(); ShowFailure("처리 요청을 전달하지 못했습니다. 세션이 종료되면 다시 실행하세요.\r\n" + error.Message); }
                return;
            }
            Process child = new Process();
            child.StartInfo = new ProcessStartInfo { FileName = node, Arguments = "\"" + backend + "\" --session", WorkingDirectory = applicationDirectory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false) };
            child.EnableRaisingEvents = true;
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) Post(delegate { if (process == child) HandleLine(args.Data); }); };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) Post(delegate { if (process == child && processErrors.Length < 32768) processErrors.AppendLine(args.Data); }); };
            child.Exited += delegate {
                ThreadPool.QueueUserWorkItem(delegate {
                    int exitCode = -1;
                    try { child.WaitForExit(); exitCode = child.ExitCode; } catch (InvalidOperationException) { }
                    Post(delegate { if (process == child) FinishProcess(exitCode); });
                });
            };
            process = child;
            try
            {
                child.Start();
                processInput = new StreamWriter(child.StandardInput.BaseStream, new UTF8Encoding(false)); processInput.AutoFlush = true;
                child.BeginOutputReadLine(); child.BeginErrorReadLine();
                processInput.WriteLine(serializer.Serialize(request));
            }
            catch (Exception error)
            {
                CloseSessionInput();
                bool exited = true; try { exited = child.HasExited; } catch (InvalidOperationException) { }
                if (!exited) { RequestCancel(); resultText.Text = "시작 요청을 전달하지 못했습니다. 입력 연결을 닫아 취소합니다.\r\n" + error.Message; return; }
                child.Dispose(); process = null; SetBusy(false); ShowFailure("처리 프로세스를 시작하지 못했습니다.\r\n" + error.Message);
            }
        }
        private void Post(MethodInvoker callback)
        {
            if (IsDisposed || Disposing || !IsHandleCreated) return;
            try { BeginInvoke(callback); } catch (InvalidOperationException) { }
        }
        private void HandleLine(string line)
        {
            try
            {
                IDictionary<string, object> message = serializer.DeserializeObject(line) as IDictionary<string, object>;
                if (message == null) throw new FormatException("결과 메시지 형식이 올바르지 않습니다.");
                string type = TextValue(message, "type");
                if (type == "progress") { statusLabel.Text = StageText(TextValue(message, "stage")); string detail = TextValue(message, "message"); if (!String.IsNullOrEmpty(detail)) statusLabel.Text += " · " + detail; return; }
                if (type != "result") throw new FormatException("알 수 없는 결과 메시지를 받았습니다.");
                receivedResult = true;
                bool ok = BoolValue(message, "ok");
                SetBusy(false);
                if (ok) { HandleSuccess(message); operationSucceeded = true; }
                else if (BoolValue(message, "cancelled")) { statusLabel.Text = "처리를 취소했습니다."; resultText.Text = "배포 사본이나 새 계약을 저장하지 않고 작업을 종료했습니다."; }
                else { string error = TextValue(message, "error"); ShowFailure(String.IsNullOrEmpty(error) ? "처리를 완료하지 못했습니다." : error); }
                progress.Style = ProgressBarStyle.Continuous; progress.Value = ok ? 100 : 0;
                if (!ok) editAdvancedAfterSettings = false;
                if (closeRequested) CloseSessionInput();
            }
            catch (Exception error) { operationSucceeded = false; editAdvancedAfterSettings = false; ShowFailure("결과 메시지를 읽지 못했습니다.\r\n" + error.Message); RequestCancel(); CloseSessionInput(); }
        }
        private void HandleSuccess(IDictionary<string, object> message)
        {
            if (action == "presets")
            {
                string selected = SelectedPreset() == null ? "protect" : SelectedPreset().Id;
                IList values = Value(message, "presets") as IList;
                if (values == null || values.Count == 0) throw new FormatException("작업 프리셋이 비어 있습니다.");
                loadingPresets = true;
                presetBox.Items.Clear();
                foreach (object value in values)
                {
                    IDictionary<string, object> entry = value as IDictionary<string, object>;
                    if (entry == null) throw new FormatException("작업 프리셋 형식이 올바르지 않습니다.");
                    presetBox.Items.Add(new PresetItem { Id = TextValue(entry, "id"), Label = TextValue(entry, "label"), Description = TextValue(entry, "description"), CheckOnly = BoolValue(entry, "checkOnly"), RequiresCleanupContract = BoolValue(entry, "requiresCleanupContract") });
                }
                presetBox.SelectedIndex = 0;
                for (int i = 0; i < presetBox.Items.Count; i++) if (((PresetItem)presetBox.Items[i]).Id == selected) { presetBox.SelectedIndex = i; break; }
                loadingPresets = false; lastPresetId = SelectedPreset() == null ? null : SelectedPreset().Id;
                statusLabel.Text = "입력 맵과 작업 프리셋을 선택하세요.";
                return;
            }
            if (action == "settings")
            {
                effectiveConfiguration = Value(message, "config") as IDictionary<string, object>;
                if (effectiveConfiguration == null) throw new FormatException("적용 설정이 없습니다.");
                resultText.Text = DescribeSettings(effectiveConfiguration); resultTabs.SelectedIndex = 0; statusLabel.Text = "최종 적용 설정을 확인했습니다.";
                bool edit = editAdvancedAfterSettings; editAdvancedAfterSettings = false;
                if (edit && !automatedMode && !closeRequested)
                {
                    using (AdvancedSettingsForm dialog = new AdvancedSettingsForm(effectiveConfiguration, advancedOverrides, noVm))
                    {
                        if (dialog.ShowDialog(this) == DialogResult.OK) { advancedOverrides = dialog.Overrides; noVm = dialog.NoVm; InvalidateConfiguration(); UpdateAvailability(); resultText.Text = "고급 설정을 적용했습니다. 적용 설정 확인으로 JSON과 합친 최종 값을 확인하세요."; statusLabel.Text = "고급 설정을 적용했습니다."; }
                    }
                }
                return;
            }
            if (action == "compare")
            {
                IList comparisons = Value(message, "comparisons") as IList;
                if (comparisons == null || comparisons.Count == 0) throw new FormatException("설정 조합 비교 결과가 없습니다.");
                combinationsGrid.Rows.Clear(); int successful = 0;
                foreach (object value in comparisons)
                {
                    IDictionary<string, object> comparison = value as IDictionary<string, object>; if (comparison == null) throw new FormatException("설정 조합 결과 형식이 올바르지 않습니다.");
                    bool ok = BoolValue(comparison, "ok"); if (ok) successful++;
                    IDictionary<string, object> itemSummary = Value(comparison, "summary") as IDictionary<string, object>;
                    double before = NumberValue(itemSummary, "inputBytes"), after = NumberValue(itemSummary, "outputBytes");
                    int row = combinationsGrid.Rows.Add(TextValue(comparison, "label"), ok ? "성공" : "거부", ok ? FormatBytes(after) : "—", ok ? FormatChange(before - after) : "—", ok ? Percent(before, after) : "—", Seconds(Value(comparison, "elapsedMs")), TextValue(comparison, "error"));
                    combinationsGrid.Rows[row].Tag = comparison; combinationsGrid.Rows[row].Cells[6].ToolTipText = TextValue(comparison, "error");
                }
                resultTabs.SelectedIndex = 2; statusLabel.Text = "설정 조합 비교 완료 · 성공 " + successful + " / " + comparisons.Count;
                resultText.Text = "여러 설정을 메모리에서 검사했습니다. 맵 파일은 저장하지 않았습니다.\r\n현재 설정 조합은 JSON과 고급 설정을 포함하며 나머지는 기본 프리셋을 비교합니다.\r\n성공한 조합을 선택한 뒤 선택한 조합 적용을 누르면 다음 작업의 설정이 바뀝니다.\r\n검토 계약이 없거나 변환을 지원하지 않는 조합은 거부 원인을 표시합니다.";
                UpdateAvailability(); return;
            }
            if (action == "review" || action == "save-contract")
            {
                IDictionary<string, object> review = Value(message, "review") as IDictionary<string, object>;
                if (review == null) throw new FormatException("검토 비교 결과가 없습니다.");
                reviewEligible = BoolValue(review, "repackOnly") && Value(review, "candidate") != null;
                StringBuilder text = new StringBuilder();
                text.AppendLine(reviewEligible ? "내용이 동일하고 재포장만 확인되었습니다. 새 계약을 저장할 수 있습니다." : "내용 또는 검토 조건이 달라져 새 검토가 필요합니다.");
                IList reasons = Value(review, "reReviewReasons") as IList;
                if (reasons != null) foreach (object reason in reasons) text.AppendLine("• " + Convert.ToString(reason));
                IList changes = Value(review, "changes") as IList;
                if (changes != null) foreach (object value in changes) { IDictionary<string, object> change = value as IDictionary<string, object>; if (change != null) text.AppendLine("• " + TextValue(change, "entry") + " : " + TextValue(change, "reason")); }
                if (action == "save-contract") { string path = TextValue(message, "path"); text.AppendLine("새 계약: " + path); cleanupContractPath.Text = path; statusLabel.Text = "새 검토 계약을 저장했습니다."; }
                else statusLabel.Text = "입력 · 계약 비교를 완료했습니다.";
                reviewHint.Text = reviewEligible ? "새 검토 계약 저장이 가능합니다. 저장 전에 프로그램이 입력과 이전 계약을 다시 확인합니다." : "표시된 변경 내용을 검토한 뒤 새 계약을 준비하세요.";
                resultText.Text = text.ToString(); resultTabs.SelectedIndex = 0; return;
            }
            IDictionary<string, object> summary = Value(message, "summary") as IDictionary<string, object>;
            if (summary == null) throw new FormatException("맵 처리 요약이 없습니다.");
            IDictionary<string, object> lua = Value(summary, "lua") as IDictionary<string, object>;
            IDictionary<string, object> strings = Value(summary, "strings") as IDictionary<string, object>;
            IDictionary<string, object> vm = Value(summary, "vm") as IDictionary<string, object>;
            IList removed = Value(summary, "removedFiles") as IList;
            StringBuilder report = new StringBuilder();
            report.AppendLine(action == "check" ? "검사 완료 · 맵 파일을 저장하지 않았습니다." : "검증된 배포 사본을 저장했습니다.");
            report.AppendLine("맵 크기: " + FormatBytes(Value(summary, "inputBytes")) + " → " + FormatBytes(Value(summary, "outputBytes")));
            report.AppendLine("절감: " + FormatChange(NumberValue(summary, "inputBytes") - NumberValue(summary, "outputBytes")) + " (" + Percent(NumberValue(summary, "inputBytes"), NumberValue(summary, "outputBytes")) + ")");
            report.AppendLine("Lua 크기: " + FormatBytes(Value(lua, "inputBytes")) + " → " + FormatBytes(Value(lua, "outputBytes")));
            report.AppendLine("local 이름 변경: " + TextValue(lua, "renamedLocals") + "개   문자열 숨김: " + TextValue(strings, "encodedLiterals") + "개   파일 정리: " + (removed == null ? 0 : removed.Count) + "개");
            string mode = TextValue(strings, "mode"); if (mode.Length > 0) report.AppendLine("문자열 모드: " + mode + (mode == "runtime" ? " · 고유 복원 문자열 " + NumberValue(strings, "uniqueRuntimeLiterals") + "개 (실험)" : ""));
            report.AppendLine("VM 함수: " + NumberValue(vm, "virtualizedFunctions") + "개" + (NumberValue(vm, "virtualizedFunctions") > 0 ? " · 명령 " + NumberValue(vm, "instructions") + "개 (실험 · 게임 검증 필요)" : ""));
            IDictionary<string, object> natives = Value(summary, "natives") as IDictionary<string, object>;
            if (Value(lua, "renamedGlobals") != null || Value(lua, "renamedFields") != null || NumberValue(natives, "hiddenNatives") > 0)
                report.AppendLine("전역 이름 변경: " + NumberValue(lua, "renamedGlobals") + "개   필드 이름 변경: " + NumberValue(lua, "renamedFields") + "개 (닫힌 테이블 " + NumberValue(lua, "closedTables") + "개)   엔진 함수 숨김: " + NumberValue(natives, "hiddenNatives") + "개 (실험)");
            report.AppendLine("MPQ 섹터 크기: " + FormatBytes(Value(summary, "sectorSize")) + (NumberValue(summary, "sectorSize") != 4096 ? " (기본 4 KiB와 다름 · 실험 · 게임 검증 필요)" : ""));
            IDictionary<string, object> cache = Value(message, "cache") as IDictionary<string, object>; lastCacheReused = BoolValue(cache, "reused");
            if (cache != null) { report.AppendLine("검사 결과: " + (lastCacheReused ? "이전 검증 결과 재사용" : "새 검사") + " · 처리 시간 " + Seconds(Value(message, "elapsedMs"))); report.AppendLine(BoolValue(cache, "retained") ? "이 결과를 메모리에 보관했습니다. 같은 입력 · 설정의 다음 작업에서 재사용합니다." : "이 결과는 메모리에 보관하지 않습니다. 다음 작업에서 다시 검사합니다."); }
            FillSavings(Value(summary, "savings") as IDictionary<string, object>, report);
            if (action == "protect") report.AppendLine("배포 사본: " + (String.IsNullOrEmpty(TextValue(message, "path")) ? outputPath.Text : TextValue(message, "path")));
            if (removed != null) foreach (object name in removed) report.AppendLine("• 정리: " + Convert.ToString(name));
            report.AppendLine("실제 게임 실행과 멀티플레이 동기화·성능 확인은 별도로 필요합니다.");
            resultText.Text = report.ToString(); resultTabs.SelectedIndex = 0; statusLabel.Text = action == "check" ? "맵 검사를 완료했습니다." : "배포 사본 저장을 완료했습니다.";
        }
        private void FillSavings(IDictionary<string, object> savings, StringBuilder report)
        {
            savingsGrid.Rows.Clear(); if (savings == null) return;
            IList stages = Value(savings, "stages") as IList;
            if (stages != null) { report.AppendLine(); report.AppendLine("단계별 절감 (실제 파일 재압축 · 빈 공간 회수를 포함)"); foreach (object value in stages) { IDictionary<string, object> stage = value as IDictionary<string, object>; if (stage != null) report.AppendLine("• " + TextValue(stage, "label") + ": " + FormatChange(NumberValue(stage, "savedBytes"))); } }
            IDictionary<string, object> storage = Value(savings, "storage") as IDictionary<string, object>;
            if (storage != null) report.AppendLine("파일 데이터 외 공간: " + FormatBytes(Value(storage, "beforeOtherBytes")) + " → " + FormatBytes(Value(storage, "afterOtherBytes")));
            IList files = Value(savings, "files") as IList; if (files == null) return;
            foreach (object value in files)
            {
                IDictionary<string, object> file = value as IDictionary<string, object>; if (file == null) continue; IList names = Value(file, "names") as IList;
                string name = names == null || names.Count == 0 ? "MPQ block #" + TextValue(file, "blockIndex") : JoinValues(names);
                double before = NumberValue(file, "beforeBytes"), after = NumberValue(file, "afterBytes");
                string label = TextValue(file, "label"); if (label.Length == 0) label = FileKind(TextValue(file, "kind"));
                int row = savingsGrid.Rows.Add(name, label, FormatBytes(before), FormatBytes(after), FormatChange(NumberValue(file, "savedBytes")), Percent(before, after)); savingsGrid.Rows[row].Cells[0].ToolTipText = name; savingsGrid.Rows[row].Cells[1].ToolTipText = label;
            }
        }
        private string DescribeSettings(IDictionary<string, object> config)
        {
            StringBuilder text = new StringBuilder("프리셋 → 설정 JSON → 고급 설정 → 화면 문자열 선택 순서로 적용한 최종 설정입니다.\r\n\r\n");
            IDictionary<string, object> lua = Value(config, "lua") as IDictionary<string, object>, strings = Value(config, "strings") as IDictionary<string, object>, cleanup = Value(config, "cleanup") as IDictionary<string, object>, compression = Value(config, "compression") as IDictionary<string, object>;
            text.AppendLine("Lua 주석 · 공백 정리: " + OnOff(BoolValue(lua, "minify")) + " / local 이름 변경: " + OnOff(BoolValue(lua, "renameLocals")));
            text.AppendLine("이름 모드: " + TextValue(lua, "nameMode") + " / 재현 시드: " + TextValue(lua, "seed"));
            text.AppendLine("문자열 숨김: " + OnOff(BoolValue(strings, "enabled")) + " / 모드: " + TextValue(strings, "mode"));
            text.AppendLine("VM 선택 함수: " + JoinValues(Value(lua, "vmFunctions") as IList));
            text.AppendLine("전역 이름 변경: " + OnOff(BoolValue(lua, "renameGlobals")) + " / 닫힌 테이블 필드 이름 변경: " + OnOff(BoolValue(lua, "renameFields")) + " / 엔진 함수 호출 숨김: " + OnOff(BoolValue(lua, "hideNatives")));
            object shift = Value(compression, "sectorSizeShift");
            text.AppendLine("MPQ 섹터 크기: " + (shift == null ? "입력 유지" : (512 << Convert.ToInt32(shift)) / 1024 + " KiB (전체 재압축)"));
            if (TextValue(lua, "nameMode") == "seeded" || (BoolValue(strings, "enabled") && TextValue(strings, "mode") == "runtime") || (Value(lua, "vmFunctions") as IList) != null && ((IList)Value(lua, "vmFunctions")).Count > 0 ||
                BoolValue(lua, "renameGlobals") || BoolValue(lua, "renameFields") || BoolValue(lua, "hideNatives") || shift != null) text.AppendLine("보호 강화 · 섹터 크기 옵션은 실험 단계입니다. 실제 게임 동작과 멀티플레이 검증이 필요합니다.");
            text.AppendLine("에디터 파일 정리: " + OnOff(BoolValue(cleanup, "editor")) + " / 개발 파일 정리: " + OnOff(BoolValue(cleanup, "development")));
            text.AppendLine("파일 재압축: " + OnOff(BoolValue(compression, "enabled")) + " / 레벨: " + JoinValues(Value(compression, "levels") as IList) + " / 전략: " + JoinValues(Value(compression, "strategies") as IList));
            text.AppendLine("보존 local: " + JoinValues(Value(lua, "keepLocals") as IList));
            text.AppendLine("보존 전역: " + JoinValues(Value(lua, "keepGlobals") as IList));
            text.AppendLine("보존 문자열: " + serializer.Serialize(Value(strings, "keep")));
            text.AppendLine("정리에서 보존: " + JoinValues(Value(cleanup, "keepFiles") as IList));
            text.AppendLine("재압축 제외: " + JoinValues(Value(compression, "excludeFiles") as IList));
            if (BoolValue(cleanup, "editor") || BoolValue(cleanup, "development")) text.AppendLine("파일 정리는 의존성 검사를 거칩니다. 동적 참조가 있는 맵은 메인 작업 화면에서 입력에 맞는 검토 계약을 선택하세요.");
            return text.ToString();
        }
        private static string JoinValues(IList values) { if (values == null || values.Count == 0) return "없음"; List<string> labels = new List<string>(); foreach (object value in values) labels.Add(Convert.ToString(value)); return String.Join(", ", labels.ToArray()); }
        private static string OnOff(bool value) { return value ? "켜짐" : "꺼짐"; }
        private static string FileKind(string kind) { switch (kind) { case "rewritten": case "replaced": case "rewrite": return "내용 변경"; case "removed": case "deleted": return "파일 정리"; case "recompressed": case "recompress": return "재압축"; case "preserved": case "unchanged": return "보존"; case "added": return "추가"; default: return kind; } }
        private void FinishProcess(int exitCode)
        {
            if (busy && !receivedResult) { operationSucceeded = false; string details = processErrors.ToString().Trim(); ShowFailure("처리 프로세스가 완료 결과 없이 종료되었습니다. (종료 코드 " + exitCode + ")" + (details.Length == 0 ? "" : "\r\n" + details)); }
            CloseSessionInput();
            Process finished = process; process = null; if (finished != null) finished.Dispose(); SetBusy(false);
            if (closeRequested) Close();
        }
        private void CloseSessionInput()
        {
            if (processInput == null) return;
            try { processInput.Close(); } catch (IOException) { } catch (ObjectDisposedException) { }
            processInput = null;
        }
        private void RequestCancel()
        {
            if (!busy || process == null || cancelRequested) return;
            cancelRequested = true; statusLabel.Text = "취소 요청을 전달했습니다. 안전하게 종료하는 중입니다."; UpdateAvailability();
            try { if (processInput != null) processInput.WriteLine("{\"action\":\"cancel\"}"); }
            catch (IOException) { CloseSessionInput(); }
            catch (ObjectDisposedException) { processInput = null; }
        }
        protected override void OnFormClosing(FormClosingEventArgs args)
        {
            if (process != null) { args.Cancel = true; closeRequested = true; RequestCancel(); CloseSessionInput(); }
            base.OnFormClosing(args);
        }
        private void ShowFailure(string message)
        {
            statusLabel.Text = "처리를 완료하지 못했습니다."; resultText.Text = message;
            if (!closeRequested && !automatedMode) MessageBox.Show(this, message, "Warcraft Lua Protector", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        private static object Value(IDictionary<string, object> data, string key) { object value; return data != null && data.TryGetValue(key, out value) ? value : null; }
        private static string TextValue(IDictionary<string, object> data, string key) { object value = Value(data, key); return value == null ? "" : Convert.ToString(value); }
        private static bool BoolValue(IDictionary<string, object> data, string key) { object value = Value(data, key); return value is bool && (bool)value; }
        private static double NumberValue(IDictionary<string, object> data, string key) { object value = Value(data, key); return value == null ? 0 : Convert.ToDouble(value); }
        private static string FormatBytes(object value) { double bytes = value == null ? 0 : Convert.ToDouble(value); return Math.Abs(bytes) < 1024 * 1024 ? bytes.ToString("N0") + " B" : (bytes / (1024 * 1024)).ToString("0.00") + " MiB"; }
        private static string FormatChange(double bytes) { return bytes < 0 ? "−" + FormatBytes(-bytes) : FormatBytes(bytes); }
        private static string Percent(double before, double after) { return before == 0 ? "—" : ((before - after) / before * 100).ToString("0.00") + "%"; }
        private static string Seconds(object milliseconds) { return milliseconds == null ? "—" : (Convert.ToDouble(milliseconds) / 1000).ToString("0.00") + "초"; }
        private static string StageText(string stage)
        {
            switch (stage) { case "validate": return "입력 · 설정 확인 중"; case "settings": return "최종 설정 확인 중"; case "compare": return "설정 조합 비교 중"; case "reuse": return "입력 · 설정 확인 후 검증 결과 재사용"; case "lua": return "Lua 보호 처리 중"; case "archive": return "맵 압축 · 파일 정리 중"; case "sectors": return "MPQ 섹터 크기 변경 · 전체 재압축 중"; case "verify": return "결과 검증 중"; case "write": return "새 파일 저장 중"; case "publishing": return "새 파일 확정 중"; case "cancelling": return "취소 · 임시 파일 정리 중"; case "review": return "입력 · 계약 비교 중"; default: return "처리 중"; }
        }
        public bool SmokeTest()
        {
            return SelectedPreset() != null && SelectedPreset().Id == "protect" && presetBox.Items.Count == 6 && !hideStrings.Checked && !noVm && !busy && process == null && tabs.TabPages.Count == 2 && resultTabs.TabPages.Count == 3 && !saveContractButton.Enabled && !protectButton.Enabled && settingsButton.Enabled && advancedButton.Enabled && !applyCombinationButton.Enabled && String.IsNullOrEmpty(inputPath.Text);
        }
        public bool SmokeCheck(string source)
        {
            if (!SmokeTest() || !Path.IsPathRooted(source) || !File.Exists(source)) return false;
            automatedMode = true;
            CreateControl(); IntPtr handle = Handle;
            inputPath.Text = source;
            outputPath.Text = source;
            try
            {
                StartProtection("check");
                if (!WaitForSmokeResult() || process == null) return false;
                Process session = process;
                StartProtection("check");
                if (!WaitForSmokeResult() || !lastCacheReused || process != session) return false;
                StartSettings();
                if (!WaitForSmokeResult() || effectiveConfiguration == null || process != session) return false;
                StartCombinations();
                if (!WaitForSmokeResult() || combinationsGrid.Rows.Count == 0 || process != session) return false;
                foreach (DataGridViewRow row in combinationsGrid.Rows)
                {
                    IDictionary<string, object> comparison = row.Tag as IDictionary<string, object>;
                    if (BoolValue(comparison, "ok") && Value(comparison, "config") is IDictionary<string, object>) { combinationsGrid.CurrentCell = row.Cells[0]; ApplyCombination(); return advancedOverrides.Count > 0 && String.IsNullOrEmpty(configurationPath.Text); }
                }
                return false;
            }
            finally
            {
                if (busy) RequestCancel();
                CloseSessionInput();
                while (process != null || busy) { Application.DoEvents(); Thread.Sleep(15); }
            }
        }
        private bool WaitForSmokeResult()
        {
            Stopwatch elapsed = Stopwatch.StartNew(); bool timedOut = false;
            while (busy)
            {
                Application.DoEvents();
                if (!timedOut && elapsed.ElapsedMilliseconds >= 60000) { timedOut = true; RequestCancel(); CloseSessionInput(); }
                Thread.Sleep(15);
            }
            Application.DoEvents(); return !timedOut && receivedResult && operationSucceeded;
        }
        public void SavePreview(string destination)
        {
            if (!Path.IsPathRooted(destination)) throw new ArgumentException("미리보기 경로는 절대 경로여야 합니다.");
            automatedMode = true;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
            ShowInTaskbar = false;
            try
            {
                Show(); Application.DoEvents(); PerformLayout(); Application.DoEvents();
                using (Bitmap bitmap = new Bitmap(Width, Height))
                {
                    DrawToBitmap(bitmap, new Rectangle(0, 0, Width, Height));
                    using (FileStream target = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) bitmap.Save(target, ImageFormat.Png);
                }
            }
            finally { Hide(); }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            using (ProtectorForm form = new ProtectorForm())
            {
                if (args.Length == 1 && args[0] == "--smoke-test") return form.SmokeTest() ? 0 : 1;
                if (args.Length == 2 && args[0] == "--smoke-test") { try { return form.SmokeCheck(args[1]) ? 0 : 1; } catch (Exception) { return 1; } }
                if (args.Length == 2 && args[0] == "--preview") { try { form.SavePreview(args[1]); return 0; } catch (Exception) { return 1; } }
                if (args.Length != 0) return 1;
                Application.Run(form);
                return 0;
            }
        }
    }
}
