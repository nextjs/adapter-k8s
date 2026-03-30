import * as grpc from "@grpc/grpc-js";
import type { ProcessingRequest, ProcessingResponse, HeaderValue } from "./ext-proc-types.js";

export interface RoutingServerOptions {
  handler: (requestHeaders: HeaderValue[]) => Promise<ProcessingResponse>;
  port: number;
}

export function createRoutingServer(options: RoutingServerOptions) {
  const { handler, port } = options;

  const server = new grpc.Server();

  const serviceDefinition: grpc.ServiceDefinition = {
    Process: {
      path: "/envoy.service.ext_proc.v3.ExternalProcessor/Process",
      requestStream: true,
      responseStream: true,
      requestSerialize: (value: any) => Buffer.from(JSON.stringify(value)),
      requestDeserialize: (buffer: Buffer) => JSON.parse(buffer.toString()),
      responseSerialize: (value: any) => Buffer.from(JSON.stringify(value)),
      responseDeserialize: (buffer: Buffer) => JSON.parse(buffer.toString()),
    },
  };

  const serviceImpl: grpc.UntypedServiceImplementation = {
    Process: (call: grpc.ServerDuplexStream<ProcessingRequest, ProcessingResponse>) => {
      call.on("data", async (request: ProcessingRequest) => {
        try {
          if (request.requestHeaders?.headers?.headers) {
            const response = await handler(request.requestHeaders.headers.headers);
            call.write(response);
          }
        } catch (err) {
          console.error("ext_proc handler error:", err);
          call.write({
            requestHeaders: {
              response: {
                headerMutation: { setHeaders: [] },
                status: "CONTINUE",
              },
            },
          });
        }
      });

      call.on("end", () => {
        call.end();
      });

      call.on("error", (err) => {
        if ((err as any).code !== grpc.status.CANCELLED) {
          console.error("ext_proc stream error:", err);
        }
      });
    },
  };

  server.addService(serviceDefinition, serviceImpl);

  return {
    start(): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        server.bindAsync(
          `0.0.0.0:${port}`,
          grpc.ServerCredentials.createInsecure(),
          (err, boundPort) => {
            if (err) return reject(err);
            console.log(`Routing service listening on port ${boundPort}`);
            resolve({ port: boundPort });
          },
        );
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        server.tryShutdown(() => resolve());
      });
    },

    get server() {
      return server;
    },
  };
}
