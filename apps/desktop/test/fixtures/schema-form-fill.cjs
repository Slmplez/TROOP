const assert = require("node:assert/strict");
const { sleep } = require("./agent-server.cjs");

// Exercise rendered controls through ordinary DOM events, including optional and
// union branches. Keep this helper independent of React's private implementation.
async function fillSchemaForm(js, id, value) {
  async function select(path, value) {
    await js(
      `(()=>{const field=document.getElementById(${JSON.stringify(path)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(25);
  }
  const optional = await js(
    `document.getElementById(${JSON.stringify(id + "-enabled")})?.checked ?? null`,
  );
  if (optional === false) {
    await js(
      `document.getElementById(${JSON.stringify(id + "-enabled")}).click()`,
    );
    await sleep(25);
  }
  const branches = await js(
    `(()=>{const select=document.getElementById(${JSON.stringify(id + "-type")});return select?[...select.options].map(option=>({value:option.value,text:option.textContent})):null;})()`,
  );
  if (branches) {
    const chosen =
      value === null
        ? branches.find((branch) => branch.text.includes("不限定"))
        : value && typeof value === "object" && !Array.isArray(value)
          ? (branches.find((branch) =>
              branch.text.includes(value.engine_id ? "外部 CLI" : "原生 Agent"),
            ) ?? branches.find((branch) => !branch.text.includes("不限定")))
          : branches.find((branch) => !branch.text.includes("不限定"));
    assert.ok(chosen, `No schema branch for ${id}`);
    await select(id + "-type", chosen.value);
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    for (;;) {
      const removed = await js(
        `(()=>{const box=[...document.querySelectorAll('[data-schema-path]')].find(box=>box.dataset.schemaPath===${JSON.stringify(id)});const button=box&&[...box.querySelectorAll('button')].find(button=>button.textContent==='移除');if(!button)return false;button.click();return true;})()`,
      );
      if (!removed) break;
      await sleep(25);
    }
    for (let index = 0; index < value.length; index++) {
      await js(
        `(()=>{const box=[...document.querySelectorAll('[data-schema-path]')].find(box=>box.dataset.schemaPath===${JSON.stringify(id)});[...box.querySelectorAll('button')].find(button=>button.textContent.startsWith('添加')).click();})()`,
      );
      await sleep(25);
      await fillSchemaForm(js, `${id}.${index}`, value[index]);
    }
    return;
  }
  if (typeof value === "object") {
    const options = await js(
      `[...document.querySelectorAll('input[type=checkbox][id]')].map(field=>({id:field.id,checked:field.checked})).filter(field=>field.id.startsWith(${JSON.stringify(id + ".")}) && field.id.endsWith('-enabled') && !field.id.slice(${id.length + 1},-8).includes('.'))`,
    );
    for (const option of options) {
      const key = option.id.slice(id.length + 1, -8);
      if (option.checked && value[key] === undefined) {
        await js(
          `document.getElementById(${JSON.stringify(option.id)}).click()`,
        );
        await sleep(25);
      }
    }
    for (const [key, field] of Object.entries(value))
      await fillSchemaForm(js, `${id}.${key}`, field);
    return;
  }
  const result = await js(
    `(()=>{const field=document.getElementById(${JSON.stringify(id)});if(!field)return {missing:true};if(field.disabled)return {disabled:true,value:field.type==='checkbox'?field.checked:field.value};if(field.type==='checkbox'){if(field.checked!==${JSON.stringify(value)})field.click();return {ok:true};}const prototype=field.tagName==='SELECT'?HTMLSelectElement.prototype:field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true};})()`,
  );
  assert.ok(!result.missing, `Missing schema control ${id}`);
  if (result.disabled)
    assert.equal(
      String(result.value),
      String(value),
      `Immutable schema field ${id}`,
    );
  await sleep(25);
}
module.exports = { fillSchemaForm };
