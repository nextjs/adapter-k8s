import { describe, it, expect } from 'vitest';
import { renderRoutingServiceDeployment } from '../../../src/emit/templates/routing-service-deployment.js';
import { renderRoutingServiceService } from '../../../src/emit/templates/routing-service-service.js';
import { renderRoutingServiceHPA } from '../../../src/emit/templates/routing-service-hpa.js';

describe('renderRoutingServiceDeployment', () => {
  it('renders a Deployment for the routing service', () => {
    const yaml = renderRoutingServiceDeployment({ releaseName: 'my-app', buildId: 'abc123' });
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('my-app-routing-service');
    expect(yaml).toContain('containerPort: 8443');
    expect(yaml).toContain('routing-manifest');
  });
});

describe('renderRoutingServiceService', () => {
  it('renders a Service for the routing service', () => {
    const yaml = renderRoutingServiceService({ releaseName: 'my-app' });
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('my-app-routing-service');
    expect(yaml).toContain('port: 8443');
    expect(yaml).toContain('appProtocol: grpc');
  });
});

describe('renderRoutingServiceHPA', () => {
  it('renders an HPA for the routing service', () => {
    const yaml = renderRoutingServiceHPA({ releaseName: 'my-app', minReplicas: 2, maxReplicas: 10 });
    expect(yaml).toContain('kind: HorizontalPodAutoscaler');
    expect(yaml).toContain('minReplicas: 2');
    expect(yaml).toContain('maxReplicas: 10');
  });
});
