import { describe, expect, it } from 'vitest';
import { implicitUsings, parseDotnetProject, parseDotnetSolution } from './dotnet-projects';
import { parseProjectConfig } from './config';

describe('.NET project data', () => {
  it('reads SDK projects as data, normalizing references and ignoring comments and MSBuild expressions', () => {
    const project = parseDotnetProject(
      'src/Web/Web.csproj',
      `<?xml version="1.0" encoding="utf-8"?>
<Project Sdk="Microsoft.NET.Sdk.Web/8.0.0">
  <!-- <RootNamespace>Commented.Out</RootNamespace> -->
  <PropertyGroup>
    <TargetFrameworks>net8.0;net9.0</TargetFrameworks>
    <RootNamespace>Contoso.Web</RootNamespace>
    <AssemblyName>$(MSBuildProjectName).Host</AssemblyName>
    <ImplicitUsings>enable</ImplicitUsings>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\Core\\Core.csproj;..\\..\\..\\outside\\Other.csproj" />
    <ProjectReference Include="C:\\absolute\\Bad.csproj" />
    <PackageReference Include="Serilog" Version="4.0.0" />
    <PackageReference Update="Serilog" Version="4.0.1" />
    <Compile Remove="Generated\\**" />
    <Using Include="Contoso.Shared" />
    <Using Include="System.Math" Static="true" />
    <Using Include="Contoso.Core.Order" Alias="Order" />
    <Using Remove="System.Net.Http" />
  </ItemGroup>
</Project>`,
    );
    expect(project).toEqual({
      sdk: 'Microsoft.NET.Sdk.Web',
      rootNamespace: 'Contoso.Web',
      assemblyName: null,
      targetFrameworks: ['net8.0', 'net9.0'],
      implicitUsings: true,
      outputType: 'Exe',
      isTestProject: null,
      projectReferences: ['src/Core/Core.csproj', '../outside/Other.csproj'],
      packageReferences: ['Serilog'],
      compileRemove: ['Generated/**'],
      usings: [
        { name: 'Contoso.Shared', static: false, alias: null },
        { name: 'System.Math', static: true, alias: null },
        { name: 'Contoso.Core.Order', static: false, alias: 'Order' },
      ],
      usingRemoves: ['System.Net.Http'],
    });
    expect(implicitUsings(project.sdk)).toContain('Microsoft.AspNetCore.Builder');
    expect(implicitUsings('Microsoft.NET.Sdk')).not.toContain('Microsoft.AspNetCore.Builder');
  });
  it('lists the projects of .sln and .slnx solutions and routes configuration files by name', () => {
    expect(
      parseDotnetSolution(
        'build/All.sln',
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Core", "..\\src\\Core\\Core.csproj", "{1}"\nEndProject\nProject("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Folder", "Folder", "{2}"\nEndProject\n',
      ).projects,
    ).toEqual(['src/Core/Core.csproj']);
    expect(
      parseDotnetSolution(
        'All.slnx',
        '<Solution><Folder Name="/src/"><Project Path="src/App/App.csproj" /></Folder><Project Path="tests/T.csproj"/></Solution>',
      ).projects,
    ).toEqual(['src/App/App.csproj', 'tests/T.csproj']);
    expect(
      parseProjectConfig(
        'Directory.Build.props',
        '<Project><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>',
      ),
    ).toMatchObject({
      kind: 'dotnet-props',
      data: { implicitUsings: false },
    });
    expect(parseProjectConfig('src/A/A.csproj', '<Project Sdk="Microsoft.NET.Sdk" />')?.kind).toBe('dotnet-project');
  });
});
