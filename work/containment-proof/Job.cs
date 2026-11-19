using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Collections.Generic;

// Proof-only native wrapper. The unnamed job and all handles are non-inheritable.
public sealed class ElyaProofJob : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime,JobTime;public uint Flags;public UIntPtr Min,Max;public uint ActiveLimit;public UIntPtr Affinity;public uint Priority,Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
 [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public uint cb;public string reserved,desktop,title;public uint x,y,width,height,xc,yc,fill,flags;public ushort show,reserved2;public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedStartup { public Startup startup;public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr info,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr info,uint length,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref uint size);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref ExtendedStartup startup,out ProcessInfo info);
 IntPtr job=IntPtr.Zero;readonly List<IntPtr> handles=new List<IntPtr>();public uint RootPid {get;private set;}
 static Exception Error(string op){return new Win32Exception(Marshal.GetLastWin32Error(),op);}
 public ElyaProofJob(){
  job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw Error("CreateJobObject");
  var limit=new Limits();limit.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway flags.
  int size=Marshal.SizeOf(typeof(Limits));IntPtr memory=Marshal.AllocHGlobal(size);
  try{Marshal.StructureToPtr(limit,memory,false);if(!SetInformationJobObject(job,9,memory,(uint)size))throw Error("SetInformationJobObject");}
  catch{CloseHandle(job);job=IntPtr.Zero;throw;}finally{Marshal.FreeHGlobal(memory);}
 }
 public bool ObserverOutside(){bool inside;if(!IsProcessInJob(GetCurrentProcess(),job,out inside))throw Error("ObserverMembership");return !inside;}
 public void Start(string node,string fixture,string directory){
  if(RootPid!=0)throw new InvalidOperationException("ONE_ROOT_ONLY");
  foreach(string s in new[]{node,fixture,directory})if(s.Contains("\"")||s.EndsWith("\\"))throw new ArgumentException("UNSUPPORTED_PATH");
  var si=new ExtendedStartup();si.startup.cb=(uint)Marshal.SizeOf(typeof(ExtendedStartup));ProcessInfo pi;
  string win=Environment.GetEnvironmentVariable("SystemRoot")??"C:\\Windows";
  IntPtr env=Marshal.StringToHGlobalUni("PATH="+win+"\\System32\0SystemRoot="+win+"\0TEMP="+directory+"\0TMP="+directory+"\0\0");
  bool started=false,initialized=false;IntPtr size=IntPtr.Zero,listValue=IntPtr.Zero;
  try{
   InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
   if(size==IntPtr.Zero)throw Error("JobAttributeSize");
   si.attributes=Marshal.AllocHGlobal(size);listValue=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(listValue,job);
   if(!InitializeProcThreadAttributeList(si.attributes,1,0,ref size))throw Error("InitializeJobAttribute");initialized=true;
   if(!UpdateProcThreadAttribute(si.attributes,0,new IntPtr(0x2000D),listValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw Error("SetJobListAttribute");
   // Atomic job membership at creation eliminates the create/assign cleanup race.
   started=CreateProcess(node,new StringBuilder("\""+node+"\" \""+fixture+"\" parent \""+directory+"\""),IntPtr.Zero,IntPtr.Zero,false,0x08080404,env,directory,ref si,out pi);
   if(!started)throw Error("CreateProcessSuspendedInJob");
  }finally{if(initialized)DeleteProcThreadAttributeList(si.attributes);if(si.attributes!=IntPtr.Zero)Marshal.FreeHGlobal(si.attributes);if(listValue!=IntPtr.Zero)Marshal.FreeHGlobal(listValue);Marshal.FreeHGlobal(env);}
  try{
   bool inside;if(!IsProcessInJob(pi.process,job,out inside)||!inside)throw new InvalidOperationException("CREATE_TIME_MEMBERSHIP_MISSING");
   if(ResumeThread(pi.thread)==0xffffffff)throw Error("ResumeThread");
   RootPid=pi.pid;handles.Add(pi.process);
  }catch{TerminateProcess(pi.process,31028);WaitForSingleObject(pi.process,2000);CloseHandle(pi.process);throw;}
  finally{CloseHandle(pi.thread);}
 }
 public uint[] Members(){
  int size=8+IntPtr.Size*32;IntPtr memory=Marshal.AllocHGlobal(size);uint returned;
  try{if(!QueryInformationJobObject(job,3,memory,(uint)size,out returned))throw Error("QueryMembers");int count=Marshal.ReadInt32(memory,4);if(count>32)throw new InvalidOperationException("TOO_MANY_MEMBERS");uint[] ids=new uint[count];for(int i=0;i<count;i++)ids[i]=(uint)Marshal.ReadIntPtr(memory,8+i*IntPtr.Size).ToInt64();return ids;}finally{Marshal.FreeHGlobal(memory);}
 }
 public IntPtr OpenMember(uint pid){
  IntPtr h=OpenProcess(0x101001,false,pid);if(h==IntPtr.Zero)throw Error("OpenMember");
  bool inside;if(!IsProcessInJob(h,job,out inside)||!inside){CloseHandle(h);throw new InvalidOperationException("NOT_OWNED_JOB_MEMBER");}
  handles.Add(h);return h;
 }
 public uint ExitCode(IntPtr process){uint code;if(!GetExitCodeProcess(process,out code))throw Error("GetExitCode");return code;}
 public string Image(IntPtr process){var name=new StringBuilder(32768);uint size=32768;if(!QueryFullProcessImageName(process,0,name,ref size))throw Error("QueryImage");return name.ToString();}
 public void Kill(uint code){if(!TerminateJobObject(job,code))throw Error("TerminateJobObject");}
 public void Dispose(){
  // Only this unnamed job, then exact retained member handles. Never name-based kills.
  if(job!=IntPtr.Zero){TerminateJobObject(job,31028);CloseHandle(job);job=IntPtr.Zero;}
  foreach(IntPtr h in handles){if(WaitForSingleObject(h,0)==258)TerminateProcess(h,31028);WaitForSingleObject(h,2000);CloseHandle(h);}handles.Clear();
 }
}
