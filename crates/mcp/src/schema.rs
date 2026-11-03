//! Validate untrusted tool schemas without any network or filesystem resolver.
use serde_json::Value;
pub fn compile(schema: &Value) -> Result<jsonschema::Validator, String> {
    if schema.to_string().len() > 32_000 || schema["type"] != "object" {
        return Err("MCP inputSchema must be a bounded object schema".into());
    }
    let mut nodes = 0;
    inspect(schema, 0, &mut nodes)?;
    jsonschema::options()
        .with_pattern_options(jsonschema::PatternOptions::regex())
        .should_validate_formats(true)
        .should_ignore_unknown_formats(false)
        .build(schema)
        .map_err(|_| {
            "MCP schema is invalid or uses unsupported references, formats or regex".into()
        })
}
fn inspect(v: &Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
    *nodes += 1;
    if depth > 32 || *nodes > 4096 {
        return Err("MCP schema exceeds complexity budget".into());
    }
    match v {
        Value::Object(m) => {
            for (k, v) in m {
                if matches!(k.as_str(), "$ref" | "$dynamicRef" | "$recursiveRef")
                    && !v.as_str().is_some_and(|s| s.starts_with('#'))
                {
                    return Err("External MCP schema references are disabled".into());
                }
                if matches!(
                    k.as_str(),
                    "$vocabulary" | "$recursiveRef" | "$recursiveAnchor"
                ) {
                    return Err(
                        "Custom vocabularies and recursive draft keywords are unsupported".into(),
                    );
                }
                inspect(v, depth + 1, nodes)?;
            }
        }
        Value::Array(a) => {
            for v in a {
                inspect(v, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn validate(schema: &Value, args: &Value) -> Result<(), String> {
    if !args.is_object() || args.to_string().len() > 32_000 {
        return Err("MCP arguments must be a bounded object".into());
    }
    if compile(schema)?.is_valid(args) {
        Ok(())
    } else {
        Err("MCP arguments do not satisfy inputSchema".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn validates_nested_composition_references_and_constraints() {
        let s = json!({"type":"object","$defs":{"tag":{"type":"string","minLength":2,"pattern":"^[a-z]+$"}},"properties":{"tag":{"$ref":"#/$defs/tag"},"count":{"type":"integer","minimum":1,"maximum":5},"items":{"type":"array","uniqueItems":true,"items":{"type":"string"}}},"required":["tag","count"],"additionalProperties":false,"allOf":[{"not":{"properties":{"count":{"const":3}},"required":["count"]}}]});
        assert!(validate(&s, &json!({"tag":"hello","count":2,"items":["a","b"]})).is_ok());
        for v in [
            json!({"tag":"a","count":2}),
            json!({"tag":"yes","count":3}),
            json!({"tag":"yes","count":2.5}),
            json!({"tag":"yes","count":2,"items":["a","a"]}),
            json!({"tag":"yes","count":2,"extra":true}),
        ] {
            assert!(validate(&s, &v).is_err());
        }
    }
    #[test]
    fn cannot_load_remote_or_local_files_or_unsupported_formats() {
        for s in [
            json!({"type":"object","$ref":"file:///C:/private.json"}),
            json!({"type":"object","$ref":"https://example.com/schema"}),
            json!({"type":"object","properties":{"x":{"type":"string","format":"unknown-format"}}}),
            json!({"type":"object","properties":{"x":{"type":"string","pattern":"(?=secret)"}}}),
        ] {
            assert!(compile(&s).is_err());
        }
    }
    #[test]
    fn applies_2020_unevaluated_and_union_semantics() {
        let s = json!({"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","oneOf":[{"properties":{"mode":{"const":"a"},"value":{"type":"string"}},"required":["mode","value"]},{"properties":{"mode":{"const":"b"},"value":{"type":"integer"}},"required":["mode","value"]}],"unevaluatedProperties":false});
        assert!(validate(&s, &json!({"mode":"b","value":4})).is_ok());
        assert!(validate(&s, &json!({"mode":"b","value":"4"})).is_err());
        assert!(validate(&s, &json!({"mode":"a","value":"4","extra":1})).is_err());
    }
}
