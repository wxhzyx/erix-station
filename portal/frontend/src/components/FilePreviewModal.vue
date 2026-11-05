<script setup lang="ts">
import { ElButton, ElAlert, ElSkeleton, ElEmpty } from "element-plus";
import ModalShell from "./ModalShell.vue";
// 文件预览 modal（issue #84 P6 第一版；#366 P0/P1/P2 扩通道）：目录树文件节点点击 → 本 modal。
// 四条渲染通道（lib/previewRoute.ts 的纯函数按扩展名分流）：
//   native-json —— 文本/Markdown/图片：/api/file JSON 契约，逐字节沿用 #84 行为
//                  （Markdown 复用 lib/markdown.ts + mermaid；文本 <pre>；图片 base64 <img>）；
//   native-stream — PDF/音视频：浏览器原生 <object>/<video>/<audio>，src=/api/file?mode=stream；
//   kkfile —— Office/压缩包等：POST /api/preview-tickets 签能力码 → iframe 指 /pv/<码>/onlinePreview
//                  （sandbox="allow-scripts" 无 allow-same-origin：kk 产物页脚本拿不到 portal 会话）；
//   other —— 清单外：不发任何请求，直接给下载。
// 失败态（413/415/502/网络）：错误 message 直显 + 「下载」按钮（P0：死路页的出口）。
// 交互对齐 SessionPickerModal：dialog 语义（role/aria-modal）、Esc 关闭、打开焦点进 dialog、
// 关闭归还触发按钮、锁背景滚动。
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api";
import { renderMarkdown } from "../lib/markdown";
// 与 StreamPanel 同口径：.md 预览里的 ```mermaid 块也挂图（v-html 落定后 DOM 后处理）。
import { vMermaid } from "../directives/mermaid";
import {
  downloadUrl,
  isMarkdownName,
  jsonPreviewUrl,
  previewChannel,
  streamMediaKind,
  streamPreviewUrl,
} from "../lib/previewRoute";

// issue #101 P2：用户可见文案走 i18n（preview.* / common.*）；错误 message 来自后端（原样展示）。
const { t } = useI18n();

const props = defineProps<{ cwd: string; path: string }>(); // path = 相对 tree 根（= cwd）的路径
const emit = defineEmits<{ (e: "close"): void }>();

interface FilePreview {
  name: string;
  path: string;
  kind: "image" | "text";
  data: string;
}
interface PreviewTicket {
  url: string;
  expires_in: number;
}

const channel = computed(() => previewChannel(props.path));
const mediaKind = computed(() => streamMediaKind(props.path));
const dlUrl = computed(() => downloadUrl(props.cwd, props.path));

const loading = ref(true);
const error = ref("");
const preview = ref<FilePreview | null>(null);
const kkUrl = ref("");

// Markdown 分支（.md/.markdown）复用既有渲染器；其余文本原样 <pre>。
const isMarkdown = computed(() => isMarkdownName(preview.value?.name ?? ""));
const html = computed(() =>
  preview.value && isMarkdown.value ? renderMarkdown(preview.value.data) : "",
);

/** native-json 通道：#84 的原逻辑（成功进 preview，失败进 error + 下载出口）。 */
async function loadJson(): Promise<void> {
  try {
    preview.value = await api<FilePreview>(
      jsonPreviewUrl(props.cwd, props.path),
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * kkfile 通道：签能力码。票据 403 preview_code_expired（文件被 agent 改写 / 码过期）时重签一次
 * ——这是 cache-buster 语义的闭环：改写后旧码作废，自动换新码让 kk 重转。其它错误直显 + 下载。
 */
async function loadTicket(attempt = 1): Promise<void> {
  try {
    const tk = await api<PreviewTicket>("/api/preview-tickets", {
      method: "POST",
      body: JSON.stringify({ cwd: props.cwd, path: props.path }),
    });
    kkUrl.value = tk.url;
  } catch (e) {
    const expired =
      e instanceof Object &&
      "code" in e &&
      (e as { code?: string }).code === "preview_code_expired";
    if (expired && attempt === 1) return loadTicket(2);
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(async () => {
  if (channel.value === "native-json") await loadJson();
  else if (channel.value === "kkfile") await loadTicket();
  // native-stream / other 不发请求：媒体元素自加载；other 只给下载。
  loading.value = false;
});
</script>

<template>
  <ModalShell
    :label="t('preview.title', { path: props.path })"
    dialog-class="file-dialog"
    @close="emit('close')"
  >
    <section class="file-viewer">
      <header>
        <div class="file-viewer__icon" aria-hidden="true">▤</div>
        <div class="file-viewer__title">
          <h2>{{ preview?.name ?? props.path.split("/").pop() }}</h2>
          <p :title="props.path">{{ props.path }}</p>
        </div>
        <ElButton
          tag="a"
          :href="dlUrl"
          :download="props.path.split('/').pop()"
          >{{ t("preview.download") }}</ElButton
        ><ElButton
          text
          circle
          :aria-label="t('common.close')"
          @click="emit('close')"
          >×</ElButton
        >
      </header>
      <div class="file-viewer__content">
        <div v-if="loading" role="status">
          <p>{{ t("common.loading") }}</p>
          <ElSkeleton :rows="8" animated />
        </div>
        <div v-else-if="error" class="file-viewer__empty" role="alert">
          <ElAlert :title="error" type="error" :closable="false" /><ElButton
            tag="a"
            :href="dlUrl"
            :download="props.path.split('/').pop()"
            >{{ t("preview.downloadInstead") }}</ElButton
          >
        </div>
        <template v-else-if="channel === 'native-json' && preview">
          <img
            v-if="preview.kind === 'image'"
            :src="preview.data"
            :alt="preview.name"
          />
          <div v-else-if="isMarkdown" v-mermaid class="md" v-html="html"></div>
          <pre v-else class="file-viewer__code">{{ preview.data }}</pre>
        </template>
        <object
          v-else-if="channel === 'native-stream' && mediaKind === 'pdf'"
          type="application/pdf"
          :data="streamPreviewUrl(props.cwd, props.path)"
        >
          <p>{{ t("preview.pdfUnsupported") }}</p>
        </object>
        <video
          v-else-if="channel === 'native-stream' && mediaKind === 'video'"
          controls
          :src="streamPreviewUrl(props.cwd, props.path)"
        ></video>
        <audio
          v-else-if="channel === 'native-stream' && mediaKind === 'audio'"
          controls
          :src="streamPreviewUrl(props.cwd, props.path)"
        ></audio>
        <iframe
          v-else-if="channel === 'kkfile' && kkUrl"
          :src="kkUrl"
          sandbox="allow-scripts"
          :title="props.path"
        ></iframe>
        <ElEmpty v-else :description="t('preview.notPreviewable')"
          ><ElButton
            tag="a"
            type="primary"
            :href="dlUrl"
            :download="props.path.split('/').pop()"
            >{{ t("preview.download") }}</ElButton
          ></ElEmpty
        >
      </div>
    </section>
  </ModalShell>
</template>

<style scoped>
.file-viewer {
  display: flex;
  flex-direction: column;
  height: 80dvh;
  min-height: 300px;
}
.file-viewer header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 24px;
  border-bottom: 1px solid #e8edf5;
}
.file-viewer__icon {
  width: 40px;
  height: 44px;
  display: grid;
  place-items: center;
  color: #365cf5;
  background: #edf2ff;
  border-radius: 9px;
  font-size: 24px;
}
.file-viewer__title {
  flex: 1;
  min-width: 0;
}
.file-viewer h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-viewer header p {
  font-size: 11px;
  color: #8490a5;
  margin: 5px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-viewer__content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px;
  background: #fbfcfe;
}
.file-viewer__content > img,
.file-viewer__content > video {
  max-width: 100%;
  max-height: 100%;
  display: block;
  margin: auto;
}
.file-viewer__content > iframe,
.file-viewer__content > object {
  width: 100%;
  height: 100%;
  border: 0;
  background: white;
}
.file-viewer__content > audio {
  width: 100%;
  margin: 30px auto;
}
.file-viewer__code {
  font:
    12px/1.8 ui-monospace,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
}
.file-viewer__empty {
  display: grid;
  justify-items: center;
  gap: 20px;
}
@media (max-width: 600px) {
  .file-viewer header {
    padding: 14px 12px;
    gap: 6px;
  }
  .file-viewer__icon {
    display: none;
  }
  .file-viewer__content {
    padding: 14px;
  }
}
</style>
