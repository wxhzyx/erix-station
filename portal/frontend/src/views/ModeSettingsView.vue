<script setup lang="ts">
import {
  ElForm,
  ElFormItem,
  ElSelect,
  ElOption,
  ElButton,
  ElRadioGroup,
  ElRadioButton,
  ElAlert,
} from "element-plus";
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";
interface Model {
  id: string;
  model_name?: string;
  display_name?: string;
  type: string;
  tool_calling?: boolean;
  enabled?: boolean;
}
interface Provider {
  id: string;
  name: string;
  models: Model[];
}
interface Selection {
  provider_id: string;
  main: { model_id: string };
  embedding?: { model_id: string } | null;
  vision?: { model_id: string } | null;
}
interface Settings {
  providers: Provider[];
  chat: Selection | null;
  work: Selection | null;
}
interface Member {
  id: string;
  login: string;
  display_name?: string;
  status: string;
  fde_name: string | null;
}
const auth = useAuthStore();
const { locale } = useI18n();
const en = computed(() => locale.value === "en");
const users = ref<Member[]>([]),
  userId = ref("");
const settings = ref<Settings | null>(null);
const mode = ref<"chat" | "work">("chat");
const provider = ref(""),
  main = ref(""),
  embedding = ref(""),
  vision = ref("");
const error = ref(""),
  saved = ref(false),
  busy = ref(false);
let epoch = 0;
let controller = new AbortController();
const member = computed(() => users.value.find((u) => u.id === userId.value));
const models = computed(
  () =>
    settings.value?.providers
      .find((p) => p.id === provider.value)
      ?.models.filter((m) => m.enabled !== false) ?? [],
);
const mainModels = computed(() =>
  models.value.filter((m) =>
    mode.value === "chat"
      ? ["text", "vision"].includes(m.type)
      : m.type === "text" && m.tool_calling,
  ),
);
function fill() {
  const s = settings.value?.[mode.value];
  provider.value = s?.provider_id ?? "";
  main.value = s?.main.model_id ?? "";
  embedding.value = s?.embedding?.model_id ?? "";
  vision.value = s?.vision?.model_id ?? "";
  saved.value = false;
}
function providerChanged() {
  main.value = "";
  embedding.value = "";
  vision.value = "";
  saved.value = false;
}
function begin() {
  controller.abort();
  controller = new AbortController();
  error.value = "";
  saved.value = false;
  return ++epoch;
}
async function loadSettings() {
  const token = begin();
  settings.value = null;
  fill();
  if (!userId.value || auth.user?.role !== "admin") {
    busy.value = false;
    return;
  }
  if (mode.value === "work" && !member.value?.fde_name) mode.value = "chat";
  busy.value = true;
  try {
    const data = await api<Settings>(
      `/api/admin/users/${encodeURIComponent(userId.value)}/mode-settings`,
      { signal: controller.signal },
    );
    if (token === epoch) {
      settings.value = data;
      fill();
    }
  } catch (e) {
    if (token === epoch) error.value = (e as Error).message;
  } finally {
    if (token === epoch) busy.value = false;
  }
}
async function loadUsers() {
  const token = begin();
  users.value = [];
  userId.value = "";
  settings.value = null;
  fill();
  busy.value = false;
  if (auth.user?.role !== "admin") return;
  busy.value = true;
  try {
    const data = await api<{ items: Member[] }>("/api/admin/users", {
      signal: controller.signal,
    });
    if (token !== epoch) return;
    users.value = data.items.filter((u) => u.status === "active");
    userId.value =
      users.value.find((u) => u.id === auth.user?.id)?.id ??
      users.value[0]?.id ??
      "";
    await loadSettings();
  } catch (e) {
    if (token === epoch) error.value = (e as Error).message;
  } finally {
    if (token === epoch) busy.value = false;
  }
}
async function save() {
  if (
    busy.value ||
    !main.value ||
    !provider.value ||
    auth.user?.role !== "admin"
  )
    return;
  const token = epoch,
    selectedMode = mode.value;
  busy.value = true;
  error.value = "";
  saved.value = false;
  try {
    const result = await api<Selection>(
      `/api/admin/users/${encodeURIComponent(userId.value)}/mode-settings/${selectedMode}`,
      {
        method: "PUT",
        signal: controller.signal,
        body: JSON.stringify({
          provider_id: provider.value,
          main_model_id: main.value,
          ...(selectedMode === "work"
            ? {
                embedding_model_id: embedding.value || null,
                vision_model_id: vision.value || null,
              }
            : {}),
        }),
      },
    );
    if (token === epoch && settings.value) {
      settings.value[selectedMode] = result;
      saved.value = true;
    }
  } catch (e) {
    if (token === epoch) error.value = (e as Error).message;
  } finally {
    if (token === epoch) busy.value = false;
  }
}
watch(mode, fill);
watch(() => [auth.user?.id, auth.user?.role], loadUsers, { immediate: true });
onUnmounted(() => {
  epoch++;
  controller.abort();
});
</script>
<template>
  <div class="mode-settings-page">
    <main>
      <ElAlert
        v-if="auth.user?.role !== 'admin'"
        :title="en ? 'Administrator access required.' : '仅管理员可配置模型。'"
        type="error"
        :closable="false"
        role="alert"
      /><ElForm
        v-else
        label-position="top"
        class="mode-form"
        @submit.prevent="save"
        ><ElFormItem :label="en ? 'Member' : '配置用户'"
          ><ElSelect v-model="userId" :disabled="busy" @change="loadSettings"
            ><ElOption
              v-for="u in users"
              :key="u.id"
              :value="u.id"
              :label="`${u.display_name || u.login} · ${u.login}`" /></ElSelect></ElFormItem
        ><ElFormItem :label="en ? 'Mode' : '模式'"
          ><ElRadioGroup v-model="mode" :disabled="busy"
            ><ElRadioButton value="chat">{{
              en ? "Chat" : "聊天模式"
            }}</ElRadioButton
            ><ElRadioButton value="work" :disabled="!member?.fde_name">{{
              en ? "Development model" : "开发模型"
            }}</ElRadioButton></ElRadioGroup
          ></ElFormItem
        >
        <p v-if="member && !member.fde_name" class="muted">
          {{
            en
              ? "This member has no development workstation."
              : "此成员尚未分配开发工位，仅可配置聊天模型。"
          }}
        </p>
        <ElFormItem :label="en ? 'API provider' : 'API 供应商'"
          ><ElSelect
            v-model="provider"
            :disabled="busy"
            :placeholder="en ? 'Select a provider' : '选择供应商'"
            @change="providerChanged"
            ><ElOption
              v-for="p in settings?.providers"
              :key="p.id"
              :value="p.id"
              :label="p.name" /></ElSelect
        ></ElFormItem>
        <ElFormItem :label="en ? 'Main model' : '主模型'"
          ><ElSelect
            v-model="main"
            :disabled="busy"
            :placeholder="en ? 'Select a model' : '选择模型'"
            ><ElOption
              v-for="m in mainModels"
              :key="m.id"
              :value="m.id"
              :label="m.display_name || m.model_name" /></ElSelect
        ></ElFormItem>
        <div v-if="mode === 'work'" class="model-pair">
          <ElFormItem label="Embedding"
            ><ElSelect
              v-model="embedding"
              clearable
              :disabled="busy"
              :placeholder="en ? 'Not configured' : '不配置'"
              ><ElOption
                v-for="m in models.filter((m) => m.type === 'embedding')"
                :key="m.id"
                :value="m.id"
                :label="m.display_name || m.model_name" /></ElSelect
          ></ElFormItem>
          <ElFormItem :label="en ? 'Vision model' : '视觉模型'"
            ><ElSelect
              v-model="vision"
              clearable
              :disabled="busy"
              :placeholder="en ? 'Not configured' : '不配置'"
              ><ElOption
                v-for="m in models.filter((m) => m.type === 'vision')"
                :key="m.id"
                :value="m.id"
                :label="m.display_name || m.model_name" /></ElSelect
          ></ElFormItem>
        </div>
        <ElAlert
          v-if="error"
          :title="error"
          type="error"
          :closable="false"
          role="alert"
        /><ElAlert
          v-if="saved"
          :title="en ? 'Saved' : '已保存'"
          type="success"
          :closable="false"
          role="status"
        />
        <footer>
          <ElButton
            type="primary"
            native-type="submit"
            size="large"
            :loading="busy"
            :disabled="busy || !provider || !main || !userId"
            >{{ en ? "Save configuration" : "保存配置" }}</ElButton
          >
        </footer></ElForm
      >
    </main>
  </div>
</template>
<style scoped>
.mode-settings-page {
  min-height: 100dvh;
  background: #f5f7fc;
}
.mode-settings-page header {
  padding: 20px 32px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #e4e9f2;
  background: white;
}
.mode-settings-page main {
  width: 100%;
  max-width: 840px;
  padding: 48px 24px;
  margin: auto;
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #365cf5;
}
.settings-intro h1 {
  font-size: 32px;
  font-weight: 700;
  margin: 12px 0;
}
.settings-intro p {
  color: #718099;
  line-height: 1.7;
}
.mode-form {
  margin-top: 32px;
  padding: 32px;
  background: white;
  border: 1px solid #e4e9f2;
  border-radius: 20px;
}
.model-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
.mode-form footer {
  border-top: 1px solid #edf0f5;
  padding-top: 24px;
  margin-top: 24px;
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 600px) {
  .model-pair {
    grid-template-columns: 1fr;
  }
  .mode-form {
    padding: 20px;
  }
  .settings-intro h1 {
    font-size: 26px;
  }
}
</style>
