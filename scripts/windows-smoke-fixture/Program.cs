using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Only the login-free smoke's control plane is modeled. No real Docker is used.
internal sealed class DockerState
{
    public bool NetworkExists { get; set; }
    public bool VolumeExists { get; set; }
    public bool ContainerExists { get; set; }
    public bool ContainerRunning { get; set; }
    public string TokenHash { get; set; } = "";
    public Dictionary<string, string> Labels { get; set; } = new();
    public Dictionary<string, string> NetworkLabels { get; set; } = new();
    public Dictionary<string, string> VolumeLabels { get; set; } = new();
    public string[] Environment { get; set; } = Array.Empty<string>();
}

internal static class Program
{
    private const string Container = "grok-bot-local-vm";
    private const string Network = "grok-bot-local-vm-net";
    private const string Volume = "grok-bot-local-vm-control";
    private const string Image = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:3f9e25e1e382b7c4b71e08eb549098a6106fadc615feba848e6cc5c1ef4be3b6";

    private static void Require(bool condition, string reason)
    {
        if (!condition) throw new InvalidOperationException(reason);
    }

    private static string[] Values(string[] args, string option) => args
        .Select((value, index) => (value, index))
        .Where(item => item.value == option && item.index + 1 < args.Length)
        .Select(item => args[item.index + 1]).ToArray();

    private static string Value(string[] args, string option) => Values(args, option).Single();

    private static Dictionary<string, string> Labels(string[] args) => Values(args, "--label")
        .Select(label => label.Split('=', 2)).ToDictionary(parts => parts[0], parts => parts[1]);

    private static void RejectCanary(string value)
    {
        var digest = Environment.GetEnvironmentVariable("GROK_BOT_SMOKE_FORBIDDEN_SHA256");
        Require(int.TryParse(Environment.GetEnvironmentVariable("GROK_BOT_SMOKE_FORBIDDEN_LENGTH"), out var length) && length > 0, "Missing canary binding");
        for (var offset = 0; offset + length <= value.Length; offset++)
        {
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value.Substring(offset, length))));
            Require(!hash.Equals(digest, StringComparison.OrdinalIgnoreCase), "Model credential reached Docker");
        }
    }

    private static object Execute(string[] args, DockerState state)
    {
        if (args is ["info", "--format", "{{.ServerVersion}}"])
            return "28.3.0";

        if (args is ["inspect", "--format", "{{json .}}", Container])
        {
            Require(state.ContainerExists, "No such container");
            return new { State = new { Running = state.ContainerRunning }, Config = new { Image, Env = state.Environment, Labels = state.Labels }, HostConfig = new { NetworkMode = Network } };
        }

        if (args.Length >= 2 && args[0] is "network" or "volume")
        {
            var network = args[0] == "network";
            var name = network ? Network : Volume;
            var exists = network ? state.NetworkExists : state.VolumeExists;
            if (args[1] == "inspect")
            {
                Require(args.SequenceEqual(new[] { args[0], "inspect", "--format", "{{json .}}", name }), "Unexpected resource inspection");
                Require(exists, "No such resource");
                return network
                    ? new { Name = name, Driver = "bridge", Internal = false, Labels = state.NetworkLabels, Options = new Dictionary<string, string> { ["com.docker.network.bridge.enable_icc"] = "false" }, Containers = new Dictionary<string, object>() }
                    : new { Name = name, Driver = "local", Labels = state.VolumeLabels };
            }
            if (args[1] == "ls")
            {
                var filter = $"name=^{name}$";
                Require(args.SequenceEqual(new[] { args[0], "ls", "--filter", filter, "--format", "{{.Name}}" }), "Unexpected resource listing");
                return exists ? name : "";
            }
            if (args[1] == "create")
            {
                var expected = network
                    ? new[] { "network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", "--label", "com.grok-bot.local-vm-network=1", Network }
                    : new[] { "volume", "create", "--label", "com.grok-bot.local-vm-control=1", Volume };
                Require(args.SequenceEqual(expected), "Unexpected resource creation");
                if (network) { state.NetworkExists = true; state.NetworkLabels = Labels(args); }
                else { state.VolumeExists = true; state.VolumeLabels = Labels(args); }
                return name;
            }
        }

        if (args is ["container", "ls", "--all", "--filter", "name=^/grok-bot-local-vm$", "--format", "{{.Names}}"])
            return state.ContainerExists ? Container : "";

        if (args.Length == 2 && args[1] == Container && args[0] is "start" or "stop")
        {
            Require(state.ContainerExists, "No such container");
            state.ContainerRunning = args[0] == "start";
            return Container;
        }

        if (args.Length > 1 && args[0] == "run" && args.Contains("--rm"))
        {
            Require(args.Length == 19 && args.Take(18).SequenceEqual(new[] { "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--mount", $"type=volume,src={Volume},dst=/control", "--entrypoint", "/bin/sh", Image, "-ceu" }), "Unexpected token provisioning options");
            Require(state.VolumeExists && Value(args, "--network") == "none" && Value(args, "--cap-drop") == "ALL" && Value(args, "--user") == "0:0", "Invalid token provisioning scope");
            Require(Value(args, "--mount") == $"type=volume,src={Volume},dst=/control" && Value(args, "--entrypoint") == "/bin/sh" && args[^3] == Image && args[^2] == "-ceu", "Invalid token provisioning command");
            Require(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(args[^1]))).Equals("c7429679b396235e8c4537b2470bb0203258fdfd0272cddb39736fd54364558f", StringComparison.OrdinalIgnoreCase), "Invalid token provisioning script");
            var input = Console.In.ReadToEnd().Trim();
            RejectCanary(input);
            Require(input.Length == 64 && input.All(Uri.IsHexDigit), "Invalid synthetic gateway token");
            state.TokenHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input))).ToLowerInvariant();
            return "";
        }

        if (args.Length > 1 && args[0] == "run" && args[1] == "--detach")
        {
            var options = new[] { "--name", "--label", "--platform", "--restart", "--network", "--security-opt", "--cap-drop", "--env", "--publish", "--volume", "--mount" };
            for (var index = 2; index < args.Length - 1; index += 2)
                Require(options.Contains(args[index]) && index + 1 < args.Length - 1, "Unexpected container option");
            Require(!state.ContainerExists && state.NetworkExists && state.VolumeExists && state.TokenHash.Length == 64, "Resources were not provisioned");
            Require(Value(args, "--name") == Container && Value(args, "--network") == Network && args[^1] == Image, "Invalid container identity");
            Require(Value(args, "--security-opt") == "no-new-privileges:true" && Value(args, "--cap-drop") == "NET_RAW" && Value(args, "--platform") == "linux/amd64", "Invalid container isolation options");
            var labels = Labels(args);
            Require(labels.Count == 9 && labels["com.grok-bot.local-vm"] == "1" && labels["com.grok-bot.local-vm.gateway-token-sha256"] == state.TokenHash && labels["com.grok-bot.local-vm.inference-credential"] == "0" && labels["com.grok-bot.local-vm.local-auth-provider"] == "none" && labels["com.grok-bot.local-vm.model-shell"] == "box" && labels["com.grok-bot.local-vm.schema-version"] == "11", "Invalid container labels");
            foreach (var key in new[] { "host-sha256", "box-exec-daemon-sha256", "exec-daemon-wrapper-sha256" })
                Require(labels[$"com.grok-bot.local-vm.{key}"].Length == 64 && labels[$"com.grok-bot.local-vm.{key}"].All(Uri.IsHexDigit), "Invalid runtime digest");
            var environment = Values(args, "--env");
            var expectedEnvironment = new[] { "SAND_SUPERVISOR_ENABLED=1", "SAND_BOX_AUTO_UPDATE=0", "SAND_USE_EXISTING_BOX_EXEC_DAEMON=1", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps", "NODE_PATH=/home/box/deps", "SAND_GATEWAY_BIND_HOST=0.0.0.0", "SAND_HOST_PORT=1340", "SAND_GATEWAY_TOKEN_FILE=/run/grok-bot-control/gateway-token", "SAND_BOX_EXEC_SHELL_USER=box" };
            Require(environment.Order().SequenceEqual(expectedEnvironment.Order()), "Invalid container environment");
            Require(Values(args, "--publish").Order().SequenceEqual(new[] { "127.0.0.1:1340:1340", "127.0.0.1:6080:6080", "127.0.0.1:6081:6081" }.Order()), "Unexpected published port");
            Require(Values(args, "--mount").Length == 4 && Values(args, "--mount").All(value => value.EndsWith(",readonly")), "Invalid runtime mounts");
            state.Labels = labels;
            state.Environment = environment;
            state.ContainerExists = state.ContainerRunning = true;
            return Container;
        }

        if (args.Length == 7 && args.Take(6).SequenceEqual(new[] { "exec", "--user", "0:0", Container, "/bin/sh", "-ceu" }))
        {
            Require(state.ContainerRunning && Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(args[6]))).Equals("4c4f737faf88ae7f976b18eda13ecdd7812f1f0f82b54fb20ad737f685b89151", StringComparison.OrdinalIgnoreCase), "Unexpected container attestation");
            return "";
        }
        throw new InvalidOperationException("Unsupported Docker smoke command");
    }

    public static int Main(string[] args)
    {
        try
        {
            var statePath = Path.GetFullPath(Environment.GetEnvironmentVariable("GROK_BOT_SMOKE_DOCKER_STATE") ?? throw new InvalidOperationException("Missing state path"));
            var transcript = Path.GetFullPath(Environment.GetEnvironmentVariable("GROK_BOT_SMOKE_DOCKER_TRANSCRIPT") ?? throw new InvalidOperationException("Missing transcript path"));
            Require(Path.GetDirectoryName(statePath) == Path.GetDirectoryName(transcript), "State and transcript must share the owned fixture directory");
            foreach (var argument in args) RejectCanary(argument);
            var lockName = "troop-smoke-docker-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(statePath)));
            using var mutex = new Mutex(false, lockName);
            Require(mutex.WaitOne(TimeSpan.FromSeconds(15)), "Fixture state lock timed out");
            try
            {
                var state = File.Exists(statePath) ? JsonSerializer.Deserialize<DockerState>(File.ReadAllText(statePath))! : new DockerState();
                File.AppendAllText(transcript, JsonSerializer.Serialize(new { args }) + "\n");
                var output = Execute(args, state);
                var temporary = statePath + "." + Environment.ProcessId + ".tmp";
                File.WriteAllText(temporary, JsonSerializer.Serialize(state));
                File.Move(temporary, statePath, true);
                Console.WriteLine(output is string text ? text : JsonSerializer.Serialize(output));
                return 0;
            }
            finally { mutex.ReleaseMutex(); }
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 64; }
    }
}
