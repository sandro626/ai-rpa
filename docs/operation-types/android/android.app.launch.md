---
{
  "schemaVersion": 1,
  "operationType": "android.app.launch",
  "executorClass": "aivane.android.executor.AppLaunchExecutor",
  "displayName": "Launch Android App",
  "description": "Launch an Android app with a total wait budget and explicit system chooser handling.",
  "category": "app_operations",
  "platforms": [
    "android"
  ],
  "parameters": [
    {
      "name": "packageName",
      "type": "string",
      "required": true,
      "description": "Package name of the Android app to launch."
    },
    {
      "name": "choiceIndex",
      "type": "integer",
      "description": "One-based index of a currently visible chooser option. Mutually exclusive with choiceText. Does not identify an Android user or guarantee original/clone identity.",
      "minimum": 1
    },
    {
      "name": "choiceText",
      "type": "string",
      "description": "Exact unique chooser option label. Duplicate labels return selection_required. Mutually exclusive with choiceIndex."
    },
    {
      "name": "timeoutMs",
      "type": "integer",
      "default": 8000,
      "minimum": 1000,
      "maximum": 30000,
      "description": "Total launch polling budget in milliseconds. A pending platform call may take a short additional time to finish."
    },
    {
      "name": "selectionHandling",
      "type": "string",
      "enum": [
        "fail",
        "return"
      ],
      "default": "fail",
      "description": "fail stops a template if a chooser requires selection. return completes this operation with launched=false and status=selection_required so an interactive caller can continue. Always inspect the result before subsequent app operations."
    },
    {
      "name": "outputVariable",
      "type": "string",
      "description": "Variable name used to store the launch result object or field."
    },
    {
      "name": "outputKey",
      "type": "string",
      "description": "When outputVariable is set, store only this field from the result object."
    }
  ],
  "constraints": {
    "rejectUnknownParams": true
  },
  "display": {
    "summary": {
      "template": "Launch Android app {packageName}{output}",
      "tokens": {
        "packageName": {
          "param": "packageName",
          "kind": "value"
        },
        "output": {
          "firstOf": [
            "outputVariable"
          ],
          "kind": "value",
          "prefix": " -> "
        }
      }
    }
  }
}
---

# android.app.launch

The result includes `status`, `launched`, `packageName`, `foregroundPackage`, `choices`, and `message`.

Known system resolver lists are detected through accessibility. Visible options have one-based indices and labels; labels may be identical. Specify `choiceIndex` to disambiguate. Indices describe the current visible chooser, not persistent app identities. The default-selection checkbox is never changed.

The launch request is sent once. A detected chooser returns immediately unless an explicit option is supplied; a chosen option is clicked at most once. Unknown dialogs remain available for UI inspection after the bounded timeout. An explicit choice requires a chooser and verified selection, even if another instance of the same package is already foreground.
