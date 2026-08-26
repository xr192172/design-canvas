import { computeMigrationPlan } from "./src/tools/package_migration.ts";
try {
  computeMigrationPlan({ project_dir: 'c:/tmp', migrate: { moduleBase: '/', prefix: 'a', to: 'b' } });
  console.log('NO THROW');
} catch (e) {
  console.log('THREW:', e.message);
}
