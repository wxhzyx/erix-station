<script setup lang="ts">
import { ElMenu, ElMenuItem } from "element-plus";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import StationShell from "../components/StationShell.vue";
const { t, locale } = useI18n();
const route = useRoute();
const en = computed(() => locale.value === "en");
const groups = computed(() => [
  {
    label: en.value ? "DELIVERY" : "项目与交付",
    items: [
      {
        path: "/admin/delivery",
        label: en.value ? "Project delivery" : "项目交付",
      },
      {
        path: "/admin/projects",
        label: en.value ? "Shared projects" : "共享项目",
      },
      {
        path: "/admin/approvals",
        label: en.value ? "Project reviews" : "项目审批",
      },
    ],
  },
  {
    label: en.value ? "ACCESS & USAGE" : "成员与资源",
    items: [
      {
        path: "/admin/users",
        label: en.value ? "Members & workstations" : "成员与工位",
      },
      {
        path: "/admin/member-usage",
        label: en.value ? "Member usage" : "成员用量",
      },
      {
        path: "/admin/quotas",
        label: en.value ? "Token quotas" : "额度与申请",
      },
    ],
  },
  {
    label: en.value ? "PLATFORM" : "平台配置",
    items: [
      { path: "/admin/llm", label: en.value ? "API & models" : "API 与模型" },
      {
        path: "/admin/model-access",
        label: en.value ? "Model assignments" : "用户模型分配",
      },
      { path: "/admin/repos", label: en.value ? "Repositories" : "仓库接入" },
      {
        path: "/admin/preview-pool",
        label: en.value ? "Running ports" : "运行端口",
      },
    ],
  },
]);
const current = computed(() =>
  groups.value.flatMap((g) => g.items).find((i) => i.path === route.path),
);
</script>
<template>
  <StationShell area="admin">
    <div class="admin-workspace">
      <aside class="admin-navigation" :aria-label="t('admin.tabs.label')">
        <div class="admin-nav-heading">
          <strong>{{ t("admin.title") }}</strong>
        </div>
        <div v-for="group in groups" :key="group.label" class="admin-nav-group">
          <p>{{ group.label }}</p>
          <ElMenu :default-active="route.path">
            <ElMenuItem
              v-for="item in group.items"
              :key="item.path"
              :index="item.path"
            >
              <router-link
                :to="item.path"
                :aria-current="route.path === item.path ? 'page' : undefined"
                ><span class="nav-dot" aria-hidden="true"></span
                >{{ item.label }}</router-link
              >
            </ElMenuItem>
          </ElMenu>
        </div>
      </aside>
      <main class="admin-content">
        <header v-if="current" class="admin-page-heading">
          <div>

            <h1>{{ current.label }}</h1>
          </div>
          <span class="admin-context">FDE Station</span>
        </header>
        <router-view :key="route.path" />
      </main>
    </div>
  </StationShell>
</template>
<style scoped>
.admin-workspace {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  min-height: 100%;
  background: #f5f7fb;
}
.admin-navigation {
  border-right: 1px solid #e7ebf2;
  background: #fff;
  padding: 28px 16px;
}
.admin-nav-heading {
  padding: 0 12px 22px;
  display: grid;
  gap: 8px;
}
.admin-nav-heading span,
.admin-page-heading > div > span {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.5px;
  color: #8c99af;
}
.admin-nav-heading strong {
  font-size: 17px;
  color: #25344d;
}
.admin-nav-group {
  margin-bottom: 24px;
}
.admin-nav-group > p {
  padding: 0 12px;
  font-size: 10px;
  letter-spacing: 1.1px;
  color: #9aa6b9;
  font-weight: 600;
  margin-bottom: 8px;
}
.admin-nav-group :deep(.el-menu) {
  border: none;
  background: transparent;
}
.admin-nav-group :deep(.el-menu-item) {
  border-radius: 9px;
  padding: 0 12px !important;
  height: 43px;
  margin: 4px 0;
  font-size: 12px;
  color: #65738b;
}
.admin-nav-group :deep(.el-menu-item.is-active) {
  background: #edf1ff;
  color: #365cf5;
  font-weight: 600;
}
.admin-nav-group a {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-decoration: none;
  color: inherit;
}
.nav-dot {
  width: 5px;
  height: 5px;
  border: 1px solid currentColor;
  border-radius: 50%;
}
.admin-content {
  min-width: 0;
  padding: 32px;
  overflow: auto;
}
.admin-page-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 28px;
}
.admin-page-heading h1 {
  font-size: 26px;
  letter-spacing: -0.8px;
  color: #22314d;
  font-weight: 650;
  margin: 9px 0 0;
}
.admin-context {
  font-size: 11px;
  color: #98a5ba;
}
@media (max-width: 1100px) {
  .admin-workspace {
    grid-template-columns: 190px minmax(0, 1fr);
  }
  .admin-navigation {
    padding: 24px 10px;
  }
  .admin-content {
    padding: 24px;
  }
}
@media (max-width: 760px) {
  .admin-workspace {
    display: block;
  }
  .admin-navigation {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 8px 12px;
    border-right: 0;
    border-bottom: 1px solid #e7ebf2;
  }
  .admin-nav-heading,
  .admin-nav-group > p {
    display: none;
  }
  .admin-nav-group {
    margin: 0;
  }
  .admin-nav-group :deep(.el-menu) {
    display: flex;
  }
  .admin-nav-group :deep(.el-menu-item) {
    flex-shrink: 0;
  }
  .admin-content {
    padding: 20px 12px;
  }
  .admin-page-heading {
    margin-bottom: 20px;
  }
  .admin-page-heading h1 {
    font-size: 22px;
  }
  .admin-context {
    display: none;
  }
}
</style>
