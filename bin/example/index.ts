import 'source-map-support/register';

import cdk = require('@aws-cdk/core');
import { Aws } from '@aws-cdk/core';
import ec2 = require('@aws-cdk/aws-ec2');
import ecs = require('@aws-cdk/aws-ecs');
import rds = require('@aws-cdk/aws-rds');
import codebuild = require('@aws-cdk/aws-codebuild');
import ssm = require('@aws-cdk/aws-ssm');
import changeCase = require('change-case');
import { BackendStack } from '../../lib/backend-stack';
import { ApplicationCiEcrStack } from '../../lib/application-ci-ecr-stack';

const app = new cdk.App({
  context: {
    appName: 'example'
  }
});
const appName = app.node.tryGetContext('appName');

enum Env {
  prod,
  dev
}
const env:Env = app.node.tryGetContext('env') === 'prod' ? Env.prod : Env.dev;

const dbClusterForEnv = env == Env.prod ? {
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.MEMORY5, ec2.InstanceSize.LARGE),
  instances: 2
} : {
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
  instances: 1
}

const servicesForEnv = env == Env.prod ? {
  cpu: 512,
  memoryLimitMiB: 1024,
} : {
  cpu: 256,
  memoryLimitMiB: 512,
}

const parameters = require('./parameters.json');
const secrets = require('./secrets.json');

const backend = new BackendStack(app, `${appName}-${env}`, {
  env: {
    account: Aws.ACCOUNT_ID,
    region: Aws.REGION
  },
  vpc: {
    cidr: '10.10.0.0/16'
  },
  route53: {
    hostedZoneId: 'Z3N49X3U5XDHKP',
    domain: 'yoshinori-satoh.net',
    subDomain: 'app'
  },
  acm: {
    certificateArn: `arn:aws:acm:${Aws.REGION}:${Aws.ACCOUNT_ID}:certificate/42a4089e-8453-43cc-8b66-e206aad647a5`
  },
// dbInstance: {
  //   databaseName: string;
  //   masterUsername: string;
  // },
  dbCluster: {
    engine: rds.DatabaseClusterEngine.AURORA_MYSQL,
    engineVersion: '5.7.12',
    instanceProps: {
      instanceType: dbClusterForEnv.instanceType,
      parameterGroup: {
        family: 'aurora-mysql5.7'
      }
    },
    instances: dbClusterForEnv.instances,
    parameterGroup: {
      family: 'aurora-mysql5.7'
    }
  },
  services: [
    {
      name: 'laravel-app',
      targetPort: 80,
      listenerPort: 443,
      desiredCount: 1,
      assignPublicIp: true,
      enableECSManagedTags: true,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      cpu: servicesForEnv.cpu,
      memoryLimitMiB: servicesForEnv.memoryLimitMiB,
      taskDefinitionProps: {
        family: 'laravel-app',
      },
      containerDefinitionPropsArray: [
        {
          name: 'nginx',
          workingDirectory: '/var/www/html',
          ecr: {
            repositoryName: 'laravel-app-nginx',
            imageTag: '825fcec'
          },
          portMappings: [
            {
              containerPort: 80,
              hostPort: 80,
              protocol: ecs.Protocol.TCP
            }
          ],
        },
        {
          name: 'laravel',
          ecr: {
            repositoryName: 'laravel-app',
            imageTag: '825fcec'
          },
          portMappings: [
            {
              containerPort: 9000,
              hostPort: 9000,
              protocol: ecs.Protocol.TCP
            }
          ],
          environment: {
            ssmStringParameterAttributes: {
              APP_ENV: parameters.app.laravel.env.appEnv,
              APP_DEBUG: parameters.app.laravel.env.appDebug,
              APP_NAME: parameters.app.laravel.env.appName,
              APP_URL: parameters.app.laravel.env.appUrl,
            }
          },
          secrets: {
            ssmSecureStringParameterAttributes: {
              APP_KEY: parameters.app.laravel.sec.appKey
            }
          },
        }
      ]
    }
  ],
  cd: {
    git: {
      owner: parameters.cd.git.owner,
      repo: parameters.cd.git.repo,
      branch: parameters.cd.git.branch,
      oauthToken: secrets.cd.git.oauthToken
    },
  }
});

const serviceNameLaravel = 'laravel-app';
new ApplicationCiEcrStack(app, `${appName}-${serviceNameLaravel}-${env}`, {
  env: {
    account: Aws.ACCOUNT_ID,
    region: Aws.REGION
  },
  serviceName: serviceNameLaravel,
  source: {
    git: {
      owner: parameters.app.laravel.git.owner,
      repo: parameters.app.laravel.git.repo,
      branch: parameters.app.laravel.git.branch,
      oauthToken: secrets.app.laravel.git.oauthToken,
    }
  },
  builds: [
    {
      repositoryName: `${serviceNameLaravel}-nginx`,
      dockerfile: 'Dockerfile.nginx',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_2_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true
      }
    },
    {
      repositoryName: serviceNameLaravel,
      dockerfile: 'Dockerfile',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_2_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true
      }
    }
  ],
  deploy: {
    git: {
      owner: parameters.cd.git.owner,
      repo: parameters.cd.git.repo,
      branch: parameters.cd.git.branch,
      oauthToken: secrets.cd.git.oauthToken,
      config: {
        name: parameters.cd.git.config.name,
        email: parameters.cd.git.config.email,
      },
      sshKey: secrets.cd.git.sshKey,
    },
    environment: {
      buildImage: codebuild.LinuxBuildImage.STANDARD_2_0,
      computeType: codebuild.ComputeType.SMALL,
      privileged: true
    }
  }
});

app.synth();
