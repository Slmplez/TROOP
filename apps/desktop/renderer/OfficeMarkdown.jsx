import React, { useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { clientModels } from "./client/react";

export default function OfficeMarkdown({
  content,
  editable,
  onChange,
  onCompatible,
}) {
  const [problem, setProblem] = useState("正在核对 Markdown 往返保真…");
  const bom = content.startsWith("\uFEFF");
  const crlf = content.includes("\r\n");
  const ending = /\r?\n$/.test(content);
  const encode = (text) => {
    let value = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    if (ending) value += "\n";
    if (crlf) value = value.replace(/\n/g, "\r\n");
    return (bom ? "\uFEFF" : "") + value;
  };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ underline: false, link: { openOnClick: false } }),
      Markdown,
    ],
    content: content.replace(/^\uFEFF/, ""),
    contentType: "markdown",
    editable: false,
    editorProps: {
      attributes: {
        "aria-label": "Markdown 渲染内容编辑",
        role: "textbox",
        "aria-multiline": "true",
      },
      handlePaste(view, event) {
        const text = event.clipboardData?.getData("text/plain");
        if (text == null) return true;
        event.preventDefault();
        view.dispatch(view.state.tr.insertText(text));
        return true;
      },
      handleDrop: () => true,
    },
    onUpdate: ({ editor }) => onChange(encode(editor.getMarkdown())),
  });
  useEffect(() => {
    if (!editor) return;
    let active = true;
    clientModels
      .read("office.markdown.check", {
        original: content,
        candidate: encode(editor.getMarkdown()),
      })
      .then((result) => {
        if (!active) return;
        const message = result.equivalent
          ? ""
          : "此文件含当前编辑器无法保真的语法，已保留原文并关闭编辑。";
        setProblem(message);
        onCompatible(result.equivalent);
      })
      .catch((error) => {
        if (active) {
          setProblem(error.message);
          onCompatible(false);
        }
      });
    return () => {
      active = false;
    };
  }, [editor]);
  useEffect(() => {
    editor?.setEditable(editable && !problem, false);
  }, [editor, editable, problem]);
  if (problem && !problem.startsWith("正在"))
    return (
      <>
        <p role="alert">{problem}</p>
        <pre className="office-original">{content}</pre>
      </>
    );
  return (
    <>
      {problem && <p role="status">{problem}</p>}
      {editable && editor && (
        <div className="office-tools" aria-label="Markdown 格式">
          <button onClick={() => editor.chain().focus().toggleBold().run()}>
            粗体
          </button>
          <button onClick={() => editor.chain().focus().toggleItalic().run()}>
            斜体
          </button>
          <button
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
          >
            二级标题
          </button>
          <button
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            列表
          </button>
          <button
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            引用段
          </button>
          <button
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          >
            代码块
          </button>
          <button onClick={() => editor.chain().focus().undo().run()}>
            撤销
          </button>
          <button onClick={() => editor.chain().focus().redo().run()}>
            重做
          </button>
        </div>
      )}
      <EditorContent editor={editor} className="office-markdown" />
    </>
  );
}
